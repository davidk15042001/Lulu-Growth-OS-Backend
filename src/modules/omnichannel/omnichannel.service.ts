import { randomUUID } from 'node:crypto';
import { AppError, forbiddenError, notFoundError } from '../../utils/app-error.js';
import { assertWorkspaceCapability } from '../workspaces/workspace-authorization.service.js';
import { query } from '../../db/pool.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import * as repo from './omnichannel.repo.js';
import { sendMessage as sendUnifyPortMessage } from '../provider-control/unifyport.client.js';

export async function assertWorkspace(workspaceId:string,userId:string,capability:'omnichannel.read'|'omnichannel.reply'|'omnichannel.manage') { await assertWorkspaceCapability({workspaceId,userId,capability}); }
export async function list(workspaceId:string,userId:string,filters:any){await assertWorkspace(workspaceId,userId,'omnichannel.read');return repo.listConversations(workspaceId,filters);}
export async function detail(workspaceId:string,id:string,userId:string){await assertWorkspace(workspaceId,userId,'omnichannel.read');const result=await repo.getConversation(workspaceId,id);if(!result)throw notFoundError('Conversation not found');return result;}
function transportText(value:unknown){return typeof value==='string'&&value.trim()?value.trim():null;}
function recipientType(value:unknown):'user'|'group'|'channel'{return value==='group'||value==='channel'?value:'user';}

async function deliverOutboundMessage(workspaceId:string,id:string,userId:string,input:{text:string;messageType:string;clientMessageId:string;accountId?:string;recipientId?:string;recipientType?:'user'|'group'|'channel';senderType:'USER'|'AI_AGENT'}) {
  const detail=await repo.getConversation(workspaceId,id);
  if(!detail)throw notFoundError('Conversation not found');
  if(detail.conversation.status==='SPAM'||detail.conversation.status==='CLOSED')throw forbiddenError('This conversation is not accepting messages');
  const existing=detail.messages.find(message=>message.clientMessageId===input.clientMessageId);
  if(existing)return existing;
  const transport=await repo.getConversationTransport(workspaceId,id);
  if(!transport)throw notFoundError('Conversation transport not found');
  let providerMessageId:string|null=null;
  if(transport.channelType!=='WEBSITE_CHAT'){
    const identityMetadata=transport.identityMetadata??{};
    const conversationMetadata=transport.conversationMetadata??{};
    const recipientMetadata=transport.recipient?.metadata??{};
    const accountId=input.accountId??transportText(identityMetadata.unifyportAccountId)??transport.externalIdentityId;
    const recipientId=input.recipientId??transportText(recipientMetadata.externalId)??transportText(conversationMetadata.externalSenderKey)??transport.recipient?.participantKey??null;
    if(!accountId||!recipientId)throw new AppError(409,'OMNICHANNEL_DELIVERY_CONTEXT_MISSING','The social channel account or recipient is missing from this conversation.');
    const sent=await sendUnifyPortMessage({account_id:accountId,to:{id:recipientId,type:recipientType(input.recipientType??recipientMetadata.recipientType)},message:{type:input.messageType.toLowerCase(),text:input.text}});
    providerMessageId=transportText(sent.id)??transportText(sent.message_id)??transportText(sent.messageId);
  }
  return repo.createMessage({workspaceId,conversationId:id,channelId:transport.channelId,channelIdentityId:transport.channelIdentityId,direction:'OUTBOUND',senderType:input.senderType,senderUserId:userId,messageType:input.messageType,text:input.text,status:'SENT',clientMessageId:input.clientMessageId,providerMessageId},userId);
}

export async function send(workspaceId:string,id:string,userId:string,input:{text:string;messageType:string;clientMessageId?:string}) {
  await assertWorkspace(workspaceId,userId,'omnichannel.reply');
  const detail=await repo.getConversation(workspaceId,id);
  if(!detail)throw notFoundError('Conversation not found');
  if(detail.conversation.handlingMode==='AI_AUTO')throw forbiddenError('Take over the conversation before sending as a human');
  return deliverOutboundMessage(workspaceId,id,userId,{...input,clientMessageId:input.clientMessageId??`manual:${randomUUID()}`,senderType:'USER'});
}

/** Sends an agent-authored reply through the real channel transport. Website
 * chat is delivered from the database; external social channels use UnifyPort. */
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
