import { randomUUID } from 'node:crypto';
import { AppError, forbiddenError, notFoundError } from '../../utils/app-error.js';
import { assertWorkspaceCapability } from '../workspaces/workspace-authorization.service.js';
import { query } from '../../db/pool.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import * as repo from './omnichannel.repo.js';
import { asTwilioAddress, sendTwilioMessage } from '../provider-control/twilio.client.js';
import { env } from '../../config/env.js';
import { getWorkspaceTwilioContentSid, getWorkspaceTwilioCredentials } from '../provider-control/twilio-workspace.service.js';
import { sendMessage as sendUnifyPortMessage } from '../provider-control/unifyport.client.js';

export async function assertWorkspace(workspaceId:string,userId:string,capability:'omnichannel.read'|'omnichannel.reply'|'omnichannel.manage') { await assertWorkspaceCapability({workspaceId,userId,capability}); }
export async function list(workspaceId:string,userId:string,filters:any){await assertWorkspace(workspaceId,userId,'omnichannel.read');return repo.listConversations(workspaceId,filters);}
export async function detail(workspaceId:string,id:string,userId:string){await assertWorkspace(workspaceId,userId,'omnichannel.read');const result=await repo.getConversation(workspaceId,id);if(!result)throw notFoundError('Conversation not found');return result;}
function transportText(value:unknown){return typeof value==='string'&&value.trim()?value.trim():null;}
function unifyPortRecipient(value:string,recipientType:'user'|'group'|'channel'){
  if(value.includes('@'))return value;
  const digits=value.replace(/[^0-9]/g,'');
  if(!digits)throw new AppError(409,'UNIFYPORT_RECIPIENT_INVALID','The WhatsApp recipient is invalid.');
  return recipientType==='group'?`${digits}@g.us`:`${digits}@s.whatsapp.net`;
}
export function requiresWhatsAppTemplate(messages:Array<{direction:string;receivedAt?:string|null;createdAt?:string|null}>,now=Date.now()) {
  const latestInbound=messages
    .filter(message=>message.direction==='INBOUND')
    .map(message=>new Date(message.receivedAt??message.createdAt??0).getTime())
    .filter(Number.isFinite)
    .sort((a,b)=>b-a)[0]??0;
  return latestInbound===0 || now-latestInbound>=24*60*60*1000;
}

async function deliverOutboundMessage(workspaceId:string,id:string,userId:string,input:{text:string;messageType:string;clientMessageId:string;accountId?:string;recipientId?:string;recipientType?:'user'|'group'|'channel';senderType:'USER'|'AI_AGENT'}) {
  const detail=await repo.getConversation(workspaceId,id);
  if(!detail)throw notFoundError('Conversation not found');
  if(detail.conversation.status==='SPAM'||detail.conversation.status==='CLOSED')throw forbiddenError('This conversation is not accepting messages');
  const existing=detail.messages.find(message=>message.clientMessageId===input.clientMessageId);
  if(existing){
    if(existing.status==='FAILED')throw new AppError(502,'OMNICHANNEL_DELIVERY_PREVIOUSLY_FAILED','The previous delivery attempt failed; create a new delivery request before retrying.');
    return existing;
  }
  const transport=await repo.getConversationTransport(workspaceId,id);
  if(!transport)throw notFoundError('Conversation transport not found');
  const queued=await repo.createMessage({workspaceId,conversationId:id,channelId:transport.channelId,channelIdentityId:transport.channelIdentityId,direction:'OUTBOUND',senderType:input.senderType,senderUserId:userId,messageType:input.messageType,text:input.text,status:'QUEUED',clientMessageId:input.clientMessageId,providerMessageId:null},userId);
  if(transport.channelType==='WEBSITE_CHAT'){
    const delivered=await repo.updateMessageDeliveryState(workspaceId,queued.id,{status:'SENT'});
    if(!delivered)throw new AppError(500,'OMNICHANNEL_REPLY_SAVE_FAILED','The website-chat reply could not be saved.');
    return delivered;
  }
  try {
    const conversationMetadata=transport.conversationMetadata??{};
    const recipientMetadata=transport.recipient?.metadata??{};
    const recipientId=input.recipientId??transportText(recipientMetadata.externalId)??transportText(conversationMetadata.externalSenderKey)??transport.recipient?.participantKey??null;
    if(!recipientId)throw new AppError(409,'OMNICHANNEL_DELIVERY_CONTEXT_MISSING','The recipient is missing from this conversation.');
    await repo.updateMessageDeliveryState(workspaceId,queued.id,{status:'SENDING'});
    if(transport.provider==='unifyport'){
      if(transport.channelType!=='WHATSAPP')throw new AppError(409,'UNIFYPORT_CHANNEL_UNSUPPORTED','UnifyPort is enabled only for WhatsApp.');
      const recipientType=input.recipientType??(transportText(recipientMetadata.recipientType)==='group'?'group':'user');
      const sent=await sendUnifyPortMessage({
        account_id:input.accountId??transport.externalIdentityId,
        to:{id:unifyPortRecipient(recipientId,recipientType),type:recipientType},
        message:{type:'text',text:input.text},
      });
      const providerMessageId=transportText(sent.message_id)??transportText(sent.id);
      if(!providerMessageId)throw new AppError(502,'UNIFYPORT_MESSAGE_ID_MISSING','UnifyPort accepted the message without returning a message ID.');
      const delivered=await repo.updateMessageDeliveryState(workspaceId,queued.id,{status:'SENT',providerMessageId});
      if(!delivered)throw new AppError(500,'OMNICHANNEL_REPLY_SAVE_FAILED','The UnifyPort reply could not be saved.');
      return delivered;
    }
    if(transport.provider!=='twilio')throw new AppError(409,'OMNICHANNEL_PROVIDER_UNSUPPORTED',`No verified outbound adapter is enabled for ${transport.provider}.`);
    const from=asTwilioAddress(transport.channelType,input.accountId??transport.externalIdentityId);
    const to=asTwilioAddress(transport.channelType,recipientId);
    const identityAccountSid=transportText(transport.identityMetadata?.twilioAccountSid);
    const transportAuth=identityAccountSid
      ? await getWorkspaceTwilioCredentials(workspaceId,identityAccountSid)
      : null;
    if(identityAccountSid&&!transportAuth)throw new AppError(409,'TWILIO_WORKSPACE_CREDENTIALS_UNAVAILABLE','The workspace WhatsApp sender is not authorized. Lulu will use the admin sender for new conversations.');
    const needsTemplate=transport.channelType==='WHATSAPP'&&requiresWhatsAppTemplate(detail.messages);
    const contentSid=needsTemplate
      ? identityAccountSid
        ? await getWorkspaceTwilioContentSid(workspaceId,identityAccountSid)
        : env.TWILIO_WHATSAPP_CONTENT_SID
      : null;
    if(needsTemplate&&!contentSid)throw new AppError(409,identityAccountSid?'TWILIO_WORKSPACE_TEMPLATE_REQUIRED':'TWILIO_WHATSAPP_TEMPLATE_REQUIRED','An approved WhatsApp template belonging to this sender account is required outside the 24-hour customer-service window.');
    const sent=await sendTwilioMessage(needsTemplate
      ? {from,to,contentSid:contentSid!,contentVariables:{'1':input.text}}
      : {from,to,body:input.text},transportAuth??undefined);
    const delivered=await repo.updateMessageDeliveryState(workspaceId,queued.id,{status:'SENT',providerMessageId:sent.sid});
    if(!delivered)throw new AppError(500,'OMNICHANNEL_REPLY_SAVE_FAILED','The Twilio reply could not be saved.');
    return delivered;
  } catch(error) {
    await repo.updateMessageDeliveryState(workspaceId,queued.id,{status:'FAILED',errorCode:error instanceof AppError?error.code:'OMNICHANNEL_DELIVERY_FAILED'});
    throw error;
  }
}

export async function send(workspaceId:string,id:string,userId:string,input:{text:string;messageType:string;clientMessageId?:string}) {
  await assertWorkspace(workspaceId,userId,'omnichannel.reply');
  const detail=await repo.getConversation(workspaceId,id);
  if(!detail)throw notFoundError('Conversation not found');
  if(detail.conversation.handlingMode==='AI_AUTO')throw forbiddenError('Take over the conversation before sending as a human');
  return deliverOutboundMessage(workspaceId,id,userId,{...input,clientMessageId:input.clientMessageId??`manual:${randomUUID()}`,senderType:'USER'});
}

/** Sends an agent-authored reply through the real channel transport. Website
 * chat is delivered from the database, WhatsApp through UnifyPort, and
 * Messenger through Twilio. */
export async function sendAutonomousMessage(workspaceId:string,id:string,userId:string,input:{text:string;messageType?:string;clientMessageId:string;accountId?:string;recipientId?:string;recipientType?:'user'|'group'|'channel'}) {
  await assertWorkspaceCapability({workspaceId,userId,capability:'omnichannel.reply',actorType:'AI_AGENT'});
  return deliverOutboundMessage(workspaceId,id,userId,{...input,messageType:input.messageType??'TEXT',senderType:'AI_AGENT'});
}
export async function note(workspaceId:string,id:string,userId:string,text:string){await assertWorkspace(workspaceId,userId,'omnichannel.reply');const result=await repo.getConversation(workspaceId,id);if(!result)throw notFoundError('Conversation not found');return repo.createMessage({workspaceId,conversationId:id,channelId:result.conversation.channelId,channelIdentityId:result.conversation.channelIdentityId,direction:'INTERNAL',senderType:'USER',senderUserId:userId,messageType:'INTERNAL_NOTE',text},userId);}
export async function update(workspaceId:string,id:string,userId:string,input:any){await assertWorkspace(workspaceId,userId,'omnichannel.manage'); if(input.assignedUserId){const member=await query(`SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`,[workspaceId,input.assignedUserId]);if(!member.rows[0]) throw forbiddenError('Assigned user is not a workspace member');}const result=await repo.updateConversation(workspaceId,id,input,userId);if(!result)throw notFoundError('Conversation not found');return result;}
export async function channels(workspaceId:string,userId:string){await assertWorkspace(workspaceId,userId,'omnichannel.read');return repo.listChannels(workspaceId);}
export async function analytics(workspaceId:string,userId:string){await assertWorkspace(workspaceId,userId,'omnichannel.read');return repo.analytics(workspaceId);}
export async function createWebsite(workspaceId:string,userId:string,input:any){await assertWorkspace(workspaceId,userId,'omnichannel.manage');return repo.createWebsiteIdentity(workspaceId,input,userId);}
export async function takeOver(workspaceId:string,id:string,userId:string){return update(workspaceId,id,userId,{handlingMode:'HUMAN'});}
export async function returnToAi(workspaceId:string,id:string,userId:string,mode:'AI_AUTO'|'AI_ASSISTED'='AI_ASSISTED'){return update(workspaceId,id,userId,{handlingMode:mode});}
export async function publicSession(input:any){const result=await repo.createPublicSession(input.widgetId,input.origin,input.visitorId,input.pageContext);if(!result)throw notFoundError('Website chat widget not found or origin is not authorized');return result;}
export async function publicConversation(token:string){const session=await repo.getPublicSession(token);if(!session)return null;return repo.getPublicConversation(session.workspace_id,session.conversation_id);}
export async function publicMessage(token:string,input:any){const session=await repo.getPublicSession(token);if(!session)return null;const conversation=await repo.getConversation(session.workspace_id,session.conversation_id);if(!conversation)return null;return repo.createMessage({workspaceId:session.workspace_id,conversationId:session.conversation_id,channelId:conversation.conversation.channelId,channelIdentityId:conversation.conversation.channelIdentityId,direction:'INBOUND',senderType:'BUYER',messageType:input.messageType,text:input.text,clientMessageId:input.clientMessageId},null);}
export async function adminList(filters:any){return repo.listAdminConversations(filters);}
export async function adminRouting(){return repo.listRoutingQueue();}
export async function adminResolve(id:string,workspaceId:string,adminId:string,reason:string){const result=await repo.adminResolveRouting(id,workspaceId,adminId,reason);if(!result)throw notFoundError('Routing item not found');await recordSecurityEvent({eventType:'ADMIN_ACTION',userId:adminId,workspaceId,metadata:{action:'omnichannel.routing.resolve',targetId:id,reason}});return result;}
