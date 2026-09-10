import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { getPlatformOAuthCredential } from '../onboarding/onboarding.repo.js';
import { refreshStoredOAuthCredential } from '../onboarding/oauth.service.js';

type GoogleAdsOperation = {
  provider:'google-ads';
  action:'launch'|'pause';
  customerId:string;
  campaignId:string;
  campaignBudgetId?:string;
  accountCurrency?:string;
  budgetAmountCny?:number;
  loginCustomerId?:string;
};

type GoogleCampaignContext={campaignBudgetResourceName:string;accountCurrency:string;budgetPeriod:string};

function cleanId(value:string,label:string){
  const id=value.replaceAll('-','').trim();
  if(!/^\d+$/.test(id))throw new AppError(400,'AD_PROVIDER_IDENTIFIER_INVALID',`${label} must contain digits only.`);
  return id;
}

async function googleAccessToken(workspaceId:string){
  const credential=await getPlatformOAuthCredential(workspaceId,'google-ads');
  if(!credential)throw new AppError(409,'GOOGLE_ADS_NOT_CONNECTED','Connect a Google Ads account before launching paid campaigns.');
  const expiresAt=credential.tokenExpiresAt?Date.parse(credential.tokenExpiresAt):null;
  if(expiresAt!==null&&expiresAt<=Date.now()+300_000){
    return refreshStoredOAuthCredential({workspaceId,provider:'google-ads',encryptedRefreshToken:credential.encryptedRefreshToken});
  }
  return decryptSecret(credential.encryptedAccessToken);
}

function googleOperationBody(input:GoogleAdsOperation,verified?:GoogleCampaignContext){
  const customerId=cleanId(input.customerId,'Google Ads customer ID');
  const campaignId=cleanId(input.campaignId,'Google Ads campaign ID');
  if(input.action==='pause')return {
    mutateOperations:[{campaignOperation:{update:{resourceName:`customers/${customerId}/campaigns/${campaignId}`,status:'PAUSED'},updateMask:'status'}}],
    partialFailure:false,
  };
  if(!verified||!input.budgetAmountCny)throw new AppError(400,'AD_SPEND_BUDGET_CONTEXT_MISSING','Google Ads launch requires verified campaign context and budgetAmountCny.');
  if(verified.accountCurrency!=='CNY')throw new AppError(409,'AD_SPEND_CURRENCY_UNSUPPORTED','Autonomous launch currently requires the Google Ads account currency to be CNY so the prepaid cap is exact.');
  if(verified.budgetPeriod!=='CUSTOM_PERIOD')throw new AppError(409,'AD_SPEND_BUDGET_PERIOD_UNSUPPORTED','Autonomous launch requires a Google Ads CUSTOM_PERIOD campaign budget so the prepaid maximum is exact.');
  const totalAmountMicros=String(Math.round(input.budgetAmountCny*1_000_000));
  return {
    mutateOperations:[
      {campaignBudgetOperation:{update:{resourceName:verified.campaignBudgetResourceName,totalAmountMicros},updateMask:'total_amount_micros'}},
      {campaignOperation:{update:{resourceName:`customers/${customerId}/campaigns/${campaignId}`,status:'ENABLED'},updateMask:'status'}},
    ],
    partialFailure:false,
  };
}

async function readGoogleCampaignContext(customerId:string,campaignId:string,headers:Record<string,string>){
  const response=await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`,{
    method:'POST',headers,body:JSON.stringify({query:`SELECT customer.currency_code, campaign.campaign_budget, campaign_budget.period FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`}),signal:AbortSignal.timeout(Math.min(env.AI_REQUEST_TIMEOUT_MS,60_000)),
  });
  const body=await response.json().catch(()=>({})) as {results?:Array<{customer?:{currencyCode?:unknown};campaign?:{campaignBudget?:unknown};campaignBudget?:{period?:unknown}}>};
  if(!response.ok)throw new AppError(502,'GOOGLE_ADS_CONTEXT_READ_FAILED','Google Ads campaign context could not be verified.',{providerHttpStatus:response.status,providerResponse:body});
  const row=body.results?.[0];
  const campaignBudgetResourceName=typeof row?.campaign?.campaignBudget==='string'?row.campaign.campaignBudget:'';
  const accountCurrency=typeof row?.customer?.currencyCode==='string'?row.customer.currencyCode.toUpperCase():'';
  const budgetPeriod=typeof row?.campaignBudget?.period==='string'?row.campaignBudget.period.toUpperCase():'';
  if(!campaignBudgetResourceName||!accountCurrency||!budgetPeriod)throw new AppError(409,'GOOGLE_ADS_CAMPAIGN_CONTEXT_INCOMPLETE','Google Ads did not return a complete campaign budget context.');
  return {campaignBudgetResourceName,accountCurrency,budgetPeriod} satisfies GoogleCampaignContext;
}

/** Applies a budget-capped provider mutation. Launch is restricted to a
 * CUSTOM_PERIOD Google Ads budget, allowing the provider to enforce the exact
 * prepaid CNY ceiling rather than relying on an internal estimate. */
export async function executeAdvertisingProviderOperation(workspaceId:string,input:GoogleAdsOperation){
  if(input.provider!=='google-ads')throw new AppError(409,'AD_PROVIDER_EXECUTION_UNAVAILABLE',`Autonomous paid-campaign execution is not enabled for provider ${String(input.provider)}.`);
  if(!env.GOOGLE_ADS_DEVELOPER_TOKEN)throw new AppError(503,'GOOGLE_ADS_CONFIGURATION_MISSING','GOOGLE_ADS_DEVELOPER_TOKEN is not configured.');
  if(input.action==='launch'&&!env.GOOGLE_ADS_PREPAID_BILLING_ENABLED)throw new AppError(503,'GOOGLE_ADS_PREPAID_BILLING_UNCONFIRMED','Autonomous launch is disabled until the managed Google Ads billing account is confirmed to settle spend from Lulu prepaid funds.');
  const token=await googleAccessToken(workspaceId);
  const customerId=cleanId(input.customerId,'Google Ads customer ID');
  const campaignId=cleanId(input.campaignId,'Google Ads campaign ID');
  const headers:Record<string,string>={'Content-Type':'application/json',Authorization:`Bearer ${token}`,'developer-token':env.GOOGLE_ADS_DEVELOPER_TOKEN,...(input.loginCustomerId?{'login-customer-id':cleanId(input.loginCustomerId,'Google Ads manager customer ID')}:{})};
  const verified=input.action==='launch'?await readGoogleCampaignContext(customerId,campaignId,headers):undefined;
  if(verified&&input.campaignBudgetId){
    const requestedBudgetId=cleanId(input.campaignBudgetId,'Google Ads campaign budget ID');
    if(!verified.campaignBudgetResourceName.endsWith(`/campaignBudgets/${requestedBudgetId}`))throw new AppError(409,'GOOGLE_ADS_CAMPAIGN_BUDGET_MISMATCH','The requested budget does not belong to the target Google Ads campaign.');
  }
  if(verified&&input.accountCurrency&&verified.accountCurrency!==input.accountCurrency.toUpperCase())throw new AppError(409,'GOOGLE_ADS_ACCOUNT_CURRENCY_MISMATCH','The requested currency does not match the live Google Ads account currency.');
  const response=await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:mutate`,{
    method:'POST',
    headers,
    body:JSON.stringify(googleOperationBody(input,verified)),
    signal:AbortSignal.timeout(Math.min(env.AI_REQUEST_TIMEOUT_MS,60_000)),
  });
  const body=await response.json().catch(()=>({})) as Record<string,unknown>;
  if(!response.ok)throw new AppError(502,'GOOGLE_ADS_MUTATION_FAILED','Google Ads rejected the autonomous campaign operation.',{providerHttpStatus:response.status,providerResponse:body});
  return {provider:'google-ads',action:input.action,providerOperationId:response.headers.get('request-id'),response:body};
}
