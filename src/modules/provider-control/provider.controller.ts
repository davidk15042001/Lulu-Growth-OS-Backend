import type { NextFunction, Request, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import { AppError } from '../../utils/app-error.js';
import * as service from './provider.service.js';
import { connectionParamsSchema, providerMappingQuerySchema, providerMappingSchema, providerModeSchema, providerParamsSchema, providerSyncSchema, twilioAdminWhatsAppSenderSchema, twilioIdentitySchema, twilioWorkspaceContentTemplateSchema, twilioWorkspaceParamsSchema, unifyPortAccountSchema, unifyPortIdentitySchema } from './provider.validator.js';
import * as unifyPort from './unifyport.client.js';
import * as twilio from './twilio.client.js';
import { ingestTwilioWebhook } from './twilio.webhook.service.js';
import * as omniRepo from '../omnichannel/omnichannel.repo.js';
import * as twilioWorkspace from './twilio-workspace.service.js';
import { recordSecurityEvent } from '../security/security-event.service.js';

function workspaceId(req: WorkspaceRequest) {
  const value = req.params.workspaceId;
  if (!value || Array.isArray(value)) throw new AppError(400, 'WORKSPACE_ID_REQUIRED', 'Workspace ID is required');
  return String(value);
}

export async function catalog(_req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { return successResponse(res, 'Provider catalog loaded', { providers: await service.listProviderCatalog() }); }
  catch (error) { next(error); }
}

export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { return successResponse(res, 'Provider connections loaded', { connections: await service.listWorkspaceProviders(workspaceId(req)) }); }
  catch (error) { next(error); }
}

export async function detail(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { connectionId } = connectionParamsSchema.parse(req.params);
    return successResponse(res, 'Provider connection loaded', await service.getWorkspaceProvider(workspaceId(req), connectionId));
  } catch (error) { next(error); }
}

export async function verify(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { connectionId } = connectionParamsSchema.parse(req.params);
    return successResponse(res, 'Provider connection verification completed', await service.verifyWorkspaceProvider(workspaceId(req), connectionId, req.user!.id));
  } catch (error) { next(error); }
}

export async function changeMode(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { connectionId } = connectionParamsSchema.parse(req.params);
    const { mode } = providerModeSchema.parse(req.body);
    return successResponse(res, 'Provider mode updated', await service.changeWorkspaceProviderMode(workspaceId(req), connectionId, req.user!.id, mode));
  } catch (error) { next(error); }
}

export async function sync(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { connectionId } = connectionParamsSchema.parse(req.params);
    const { syncType } = providerSyncSchema.parse(req.body ?? {});
    return createdResponse(res, 'Provider sync queued', await service.queueWorkspaceProviderSync(workspaceId(req), connectionId, req.user!.id, syncType));
  } catch (error) { next(error); }
}

export async function disconnect(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { connectionId } = connectionParamsSchema.parse(req.params);
    return successResponse(res, 'Provider connection disconnected', await service.disconnectWorkspaceProvider(workspaceId(req), connectionId, req.user!.id));
  } catch (error) { next(error); }
}

export async function listMappings(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const query = providerMappingQuerySchema.parse(req.query);
    return successResponse(res, 'Provider object mappings loaded', { mappings: await service.listWorkspaceProviderMappings(workspaceId(req), query.luluObjectType, query.luluObjectId) });
  } catch (error) { next(error); }
}

export async function createMapping(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = providerMappingSchema.parse(req.body);
    const mappingInput = { workspaceId: workspaceId(req), actorId: req.user!.id, providerConnectionId: input.providerConnectionId, providerAccountId: input.providerAccountId, luluObjectType: input.luluObjectType, luluObjectId: input.luluObjectId, externalObjectType: input.externalObjectType, externalObjectId: input.externalObjectId, sourceOfTruth: input.sourceOfTruth, ...(input.providerAssetId === undefined ? {} : { providerAssetId: input.providerAssetId }) };
    return createdResponse(res, 'Provider object mapping created', await service.createWorkspaceProviderMapping(mappingInput));
  } catch (error) { next(error); }
}

export async function webhook(req: Request, res: Response, next: NextFunction) {
  try {
    const { provider } = providerParamsSchema.parse(req.params);
    if (provider.trim().toLowerCase().replaceAll('-', '_') === 'twilio') {
      const payload = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
      await ingestTwilioWebhook(payload, req.header('x-twilio-signature') ?? undefined);
      return res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
    const rawBody = (req as Request & { rawBody?: string }).rawBody;
    if (!rawBody) throw new AppError(400, 'PROVIDER_WEBHOOK_RAW_BODY_MISSING', 'Provider webhook raw body is missing');
    const payload = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
    const isUnifyPort = providerParamsSchema.parse(req.params).provider.trim().toLowerCase().replaceAll('-', '_') === 'unifyport';
    const signature = isUnifyPort ? req.header('x-device-signature') ?? undefined : req.header('x-signature') ?? req.header('x-provider-signature') ?? undefined;
    const timestamp = isUnifyPort ? req.header('x-device-timestamp') ?? undefined : req.header('x-timestamp') ?? undefined;
    const nonce = isUnifyPort ? undefined : req.header('x-nonce') ?? undefined;
    const connectionId = req.header('x-lulu-provider-connection-id');
    const accountId = req.header('x-lulu-provider-account-id');
    const correlationId = req.header('x-correlation-id') ?? req.header('x-request-id');
    const eventId = isUnifyPort ? req.header('x-device-event-id') ?? req.header('x-device-delivery-id') ?? undefined : req.header('x-provider-event-id') ?? req.header('x-event-id') ?? undefined;
    const result = await service.ingestProviderWebhook({ provider, rawBody, payload, ...(signature ? { signature } : {}), ...(timestamp ? { timestamp } : {}), ...(nonce ? { nonce } : {}), ...(connectionId ? { connectionId } : {}), ...(accountId ? { accountId } : {}), ...(correlationId ? { correlationId } : {}), ...(eventId ? { eventId } : {}) });
    return successResponse(res, result.duplicate ? 'Provider webhook was already processed' : 'Provider webhook accepted', result);
  } catch (error) { next(error); }
}

export async function twilioStatus(_req: Request, res: Response, next: NextFunction) {
  try {
    if (!twilio.isTwilioConfigured()) return successResponse(res, 'Twilio is not configured', { configured: false, webhookConfigured: twilio.isTwilioWebhookConfigured(), provider: 'twilio' });
    const [account, whatsapp] = await Promise.all([twilio.getTwilioAccount(), twilioWorkspace.getAdminWhatsAppConfiguration()]);
    return successResponse(res, 'Twilio status loaded', { configured: true, webhookConfigured: twilio.isTwilioWebhookConfigured(), provider: 'twilio', account: { sid: account.sid ?? null, friendlyName: account.friendly_name ?? null, status: account.status ?? null, type: account.type ?? null }, whatsapp });
  } catch (error) { next(error); }
}

export async function twilioConfigureAdminWhatsAppSender(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const input = twilioAdminWhatsAppSenderSchema.parse(req.body);
    return successResponse(res, 'Lulu WhatsApp fallback sender configured', await twilioWorkspace.configureAdminWhatsAppSender({ ...input, actorId: req.user!.id }));
  } catch (error) { next(error); }
}

export async function twilioWorkspaceAccounts(_req: AuthedRequest, res: Response, next: NextFunction) {
  try { return successResponse(res, 'Workspace WhatsApp accounts loaded', { accounts: await twilioWorkspace.listWorkspaceWhatsAppAccounts() }); }
  catch (error) { next(error); }
}

export async function twilioConfigureWorkspaceTemplate(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { contentSid } = twilioWorkspaceContentTemplateSchema.parse(req.body);
    const { workspaceId: targetWorkspaceId } = twilioWorkspaceParamsSchema.parse(req.params);
    return successResponse(res, 'Workspace WhatsApp template configured', await twilioWorkspace.configureWorkspaceWhatsAppTemplate({
      workspaceId: targetWorkspaceId, contentSid, actorId: req.user!.id,
    }));
  } catch (error) { next(error); }
}

export async function twilioRegisterIdentity(req: Request, res: Response, next: NextFunction) {
  try {
    const input = twilioIdentitySchema.parse(req.body);
    if (input.channelType === 'WHATSAPP') {
      throw new AppError(409, 'TWILIO_WHATSAPP_LEGACY_REGISTRATION_DISABLED', 'Use the verified Lulu admin sender or workspace Embedded Signup for WhatsApp.');
    }
    const address = twilio.asTwilioAddress(input.channelType, input.address);
    const identity = await omniRepo.registerTwilioIdentity({ workspaceId: input.workspaceId, channelType: input.channelType, address, displayName: input.displayName, ...(input.defaultLanguage === undefined ? {} : { defaultLanguage: input.defaultLanguage }) });
    if (!identity) throw new AppError(409, 'TWILIO_IDENTITY_REGISTRATION_CONFLICT', 'The Twilio channel is unavailable or this sender is already assigned to another workspace.');
    return createdResponse(res, 'Twilio channel identity registered', identity);
  } catch (error) { next(error); }
}

/** Platform-admin diagnostics and account lifecycle helpers for the
 * platform-scoped UnifyPort transport. Secrets never leave the server. */
export async function unifyPortStatus(_req: Request, res: Response, next: NextFunction) {
  try {
    if (!unifyPort.isUnifyPortConfigured()) return successResponse(res, 'UnifyPort is not configured', { configured: false, webhookConfigured: unifyPort.isUnifyPortWebhookConfigured(), provider: 'unifyport', whatsapp: { configured: false, identity: null, availableAccounts: [] } });
    const [workspace, accounts, identity] = await Promise.all([unifyPort.getWorkspace(), unifyPort.listAccounts(), omniRepo.getUnifyPortPlatformConfiguration()]);
    const availableAccounts=accounts.filter(account=>String(account.provider??'').toLowerCase()==='whatsapp').map(account=>({
      id:account.id??null,
      name:account.name??null,
      region:account.region??null,
      status:account.status??null,
      runtimeStatus:account.runtime_status??null,
      phone:account.provider_data&&typeof account.provider_data==='object'&&!Array.isArray(account.provider_data)&&typeof (account.provider_data as Record<string,unknown>).phone==='string'?(account.provider_data as Record<string,unknown>).phone:null,
    }));
    return successResponse(res, 'UnifyPort status loaded', {
      configured: true,
      webhookConfigured: unifyPort.isUnifyPortWebhookConfigured(),
      provider: 'unifyport',
      workspace: { id: workspace.id ?? null, name: workspace.name ?? null, status: workspace.status ?? null },
      accountCount: accounts.length,
      whatsapp:{configured:Boolean(identity&&identity.status==='ACTIVE'),identity,availableAccounts},
    });
  } catch (error) { next(error); }
}

export async function unifyPortAccounts(_req: Request, res: Response, next: NextFunction) {
  try { return successResponse(res, 'UnifyPort accounts loaded', { accounts: await unifyPort.listAccounts() }); }
  catch (error) { next(error); }
}

export async function unifyPortCreateAccount(req: Request, res: Response, next: NextFunction) {
  try { return createdResponse(res, 'UnifyPort account created', await unifyPort.createAccount(unifyPortAccountSchema.parse(req.body))); }
  catch (error) { next(error); }
}

export async function unifyPortAccount(req: Request, res: Response, next: NextFunction) {
  try { return successResponse(res, 'UnifyPort account loaded', await unifyPort.getAccount(String(req.params.accountId))); }
  catch (error) { next(error); }
}

export async function unifyPortAuth(req: Request, res: Response, next: NextFunction) {
  try { return successResponse(res, 'UnifyPort authentication state loaded', await unifyPort.getAccountAuth(String(req.params.accountId))); }
  catch (error) { next(error); }
}

export async function unifyPortStartQr(req: Request, res: Response, next: NextFunction) {
  try { return successResponse(res, 'UnifyPort QR authentication started', await unifyPort.startQrAuth(String(req.params.accountId))); }
  catch (error) { next(error); }
}

export async function unifyPortStartCode(req: Request, res: Response, next: NextFunction) {
  try { return successResponse(res, 'UnifyPort pairing-code authentication started', await unifyPort.startCodeAuth(String(req.params.accountId))); }
  catch (error) { next(error); }
}

export async function unifyPortRegisterIdentity(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const input=unifyPortIdentitySchema.parse(req.body);
    const [account,auth]=await Promise.all([unifyPort.getAccount(input.accountId),unifyPort.getAccountAuth(input.accountId)]);
    if(String(account.provider??'').toLowerCase()!=='whatsapp')throw new AppError(409,'UNIFYPORT_ACCOUNT_NOT_WHATSAPP','Only a WhatsApp account can be registered as Lulu\'s WhatsApp identity.');
    const authStatus=String(auth.status??'').toLowerCase();
    const runtimeStatus=String(account.runtime_status??'').toLowerCase();
    if(!['authenticated','authorized','connected','succeeded','success'].includes(authStatus)&&!['running','ready','connected'].includes(runtimeStatus)){
      throw new AppError(409,'UNIFYPORT_ACCOUNT_NOT_AUTHENTICATED','Finish linking the WhatsApp account before activating it in Lulu.',{authStatus:auth.status??null,runtimeStatus:account.runtime_status??null});
    }
    const identity=await omniRepo.registerUnifyPortIdentity({workspaceId:input.workspaceId??null,accountId:input.accountId,displayName:input.displayName,phone:input.phone??null,defaultLanguage:input.defaultLanguage??null,configuredBy:req.user!.id});
    if(!identity)throw new AppError(409,'UNIFYPORT_IDENTITY_REGISTRATION_CONFLICT','The UnifyPort WhatsApp channel is unavailable.');
    await recordSecurityEvent({eventType:'ADMIN_ACTION',userId:req.user!.id,workspaceId:input.workspaceId??null,metadata:{action:'unifyport.whatsapp.identity.configure',targetId:input.accountId,outcome:input.workspaceId?'workspace':'platform'}});
    return successResponse(res,input.workspaceId?'Workspace WhatsApp identity configured':'Lulu WhatsApp fallback identity configured',identity);
  } catch(error){next(error);}
}
