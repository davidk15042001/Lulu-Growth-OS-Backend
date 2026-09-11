import { AppError } from '../../utils/app-error.js';
import { createApiWalletProviderPayment, syncApiWalletProviderPayment } from '../billing/airwallex.service.js';
import * as repo from './api-wallet.repo.js';

export const getApiWalletOverview=repo.getApiWalletOverview;
export async function startApiTopup(input:{workspaceId:string;userId:string;amount:number;paymentMethod:repo.ApiPaymentMethod;returnUrl:string}){const topup=await repo.createApiTopup(input);try{return{topup:repo.publicApiTopup(await createApiWalletProviderPayment(topup,input.returnUrl)),packages:[1,1000,2500,5000,9000],aiStartsAutomaticallyAfterPayment:true};}catch(error){await repo.failApiTopup(topup.id,error instanceof AppError?error.code:'API_TOPUP_PAYMENT_CREATE_FAILED',error instanceof Error?error.message:'Unknown payment error');throw error;}}
export async function syncApiTopup(workspaceId:string,topupId:string){const topup=await repo.getApiTopup(workspaceId,topupId);if(!topup)throw new AppError(404,'API_TOPUP_NOT_FOUND','AI balance top-up not found.');const updated=await syncApiWalletProviderPayment(topup);if(!updated)throw new AppError(404,'API_TOPUP_NOT_FOUND','AI balance top-up not found.');return repo.publicApiTopup(updated);}
