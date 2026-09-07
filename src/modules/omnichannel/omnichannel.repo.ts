import { createHash, randomBytes } from 'node:crypto';
import { query } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import type { Conversation, Message } from './omnichannel.types.js';

const mapConversation = (r:any) => ({ id:r.id, workspaceId:r.workspace_id, channelId:r.channel_id, channelIdentityId:r.channel_identity_id, status:r.status, priority:r.priority, handlingMode:r.handling_mode, language:r.language ?? null, subject:r.subject ?? null, assignedUserId:r.assigned_user_id ?? null, primaryProductId:r.primary_product_id ?? null, lastMessageAt:r.last_message_at ?? null, firstMessageAt:r.first_message_at ?? null, createdAt:r.created_at, updatedAt:r.updated_at, ...(r.message_count !== undefined ? {messageCount:Number(r.message_count??0)} : {}), ...(r.unread_count !== undefined ? {unreadCount:Number(r.unread_count??0)} : {}), ...(r.channel_display_name !== undefined ? {channelDisplayName:r.channel_display_name} : {}), ...(r.identity_display_name !== undefined ? {identityDisplayName:r.identity_display_name} : {}) }) as Conversation;
const mapMessage = (r:any):Message => ({ id:r.id, conversationId:r.conversation_id, workspaceId:r.workspace_id, direction:r.direction, senderType:r.sender_type, messageType:r.message_type, textContent:r.text_content, status:r.status, providerMessageId:r.provider_message_id, clientMessageId:r.client_message_id, sentAt:r.sent_at, receivedAt:r.received_at, deliveredAt:r.delivered_at, readAt:r.read_at, failedAt:r.failed_at, createdAt:r.created_at });

export function hashToken(token:string) { return createHash('sha256').update(token).digest('hex'); }

export async function listChannels(workspaceId:string) {
  const {rows}=await query(`SELECT c.id,c.channel_type,c.provider,c.status,c.display_name,c.capabilities,
    COALESCE(jsonb_agg(jsonb_build_object('id',ci.id,'workspaceId',ci.workspace_id,'websiteId',ci.website_id,'identityType',ci.identity_type,'externalIdentityId',ci.external_identity_id,'displayName',ci.display_name,'mode',ci.mode,'status',ci.status,'defaultLanguage',ci.default_language,'capabilities',ci.capabilities)) FILTER (WHERE ci.id IS NOT NULL),'[]'::jsonb) AS identities
    FROM omni_channels c LEFT JOIN omni_channel_identities ci ON ci.channel_id=c.id AND ${workspaceId==='__ADMIN__'?'TRUE':'ci.workspace_id=$1'}
    WHERE c.channel_type NOT IN ('WECHAT','SMS')
    GROUP BY c.id ORDER BY c.display_name`,workspaceId==='__ADMIN__'?[]:[workspaceId]);
  const result=rows.map((r:any)=>({id:r.id,channelType:r.channel_type,provider:r.provider,status:r.status,displayName:r.display_name,capabilities:r.capabilities,identities:r.identities}));
  if(workspaceId!=='__ADMIN__') {
    const accounts=await query(`SELECT id,email_address,display_name,status FROM email_accounts WHERE workspace_id=$1 AND status <> 'disconnected' ORDER BY updated_at DESC`,[workspaceId]);
    const email=result.find((item:any)=>item.channelType==='EMAIL');
    if(email && accounts.rows.length){email.status='ACTIVE'; email.identities.push(...accounts.rows.map((account:any)=>({id:`email-account:${account.id}`,workspaceId,websiteId:null,identityType:'MAILBOX',externalIdentityId:account.email_address,displayName:account.display_name||account.email_address,mode:'CUSTOMER_OWNED',status:account.status==='reauth_required'?'AUTHORIZATION_REQUIRED':'ACTIVE',defaultLanguage:null,capabilities:{'messages.read':true,'messages.send':account.status==='connected'}})));}
  }
  return result;
}

export async function listConversations(workspaceId:string, filters:{page:number;limit:number;status?:string;handlingMode?:string;channelId?:string;assignedUserId?:string;search?:string}) {
  const params:any[]=[workspaceId]; const where=['c.workspace_id=$1'];
  if(filters.status){params.push(filters.status);where.push(`c.status=$${params.length}`);} if(filters.handlingMode){params.push(filters.handlingMode);where.push(`c.handling_mode=$${params.length}`);} if(filters.channelId){params.push(filters.channelId);where.push(`c.channel_id=$${params.length}`);} if(filters.assignedUserId){params.push(filters.assignedUserId);where.push(`c.assigned_user_id=$${params.length}`);} if(filters.search){params.push(`%${filters.search}%`);where.push(`(c.subject ILIKE $${params.length} OR EXISTS(SELECT 1 FROM omni_messages sm WHERE sm.conversation_id=c.id AND sm.workspace_id=c.workspace_id AND sm.text_content ILIKE $${params.length}))`);}
  const count=await query<{count:string}>(`SELECT count(*)::text AS count FROM omni_conversations c WHERE ${where.join(' AND ')}`,params); params.push(filters.limit,(filters.page-1)*filters.limit);
  const rows=await query(`SELECT c.*,ch.display_name channel_display_name,ci.display_name identity_display_name,
    (SELECT count(*) FROM omni_messages m WHERE m.conversation_id=c.id) message_count,
    (SELECT count(*) FROM omni_messages m WHERE m.conversation_id=c.id AND m.direction='INBOUND' AND m.status='RECEIVED') unread_count
    FROM omni_conversations c JOIN omni_channels ch ON ch.id=c.channel_id JOIN omni_channel_identities ci ON ci.id=c.channel_identity_id
    WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC NULLS LAST,c.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);
  return {items:rows.rows.map(mapConversation),pagination:{page:filters.page,limit:filters.limit,total:Number(count.rows[0]?.count??0)}};
}

export async function getConversation(workspaceId:string,id:string) {
  const row=await query(`SELECT c.*,ch.display_name channel_display_name,ci.display_name identity_display_name FROM omni_conversations c JOIN omni_channels ch ON ch.id=c.channel_id JOIN omni_channel_identities ci ON ci.id=c.channel_identity_id WHERE c.workspace_id=$1 AND c.id=$2`,[workspaceId,id]);
  if(!row.rows[0]) return null; const messages=await query(`SELECT * FROM omni_messages WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY created_at ASC LIMIT 500`,[workspaceId,id]);
  const participants=await query(`SELECT * FROM omni_conversation_participants WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY created_at`,[workspaceId,id]);
  return {conversation:mapConversation(row.rows[0]),messages:messages.rows.map(mapMessage),participants:participants.rows};
}

function mapPublicMessage(r:any) {
  return {
    id:r.id,
    direction:r.direction,
    senderType:r.sender_type === 'BUYER' ? 'BUYER' : 'LULU',
    messageType:r.message_type,
    textContent:r.text_content,
    status:r.status,
    sentAt:r.sent_at ?? null,
    receivedAt:r.received_at ?? null,
    deliveredAt:r.delivered_at ?? null,
    readAt:r.read_at ?? null,
    createdAt:r.created_at,
  };
}

/** Public widget DTO: never expose tenant, provider, assignment or internal-note data. */
export async function getPublicConversation(workspaceId:string,id:string) {
  const row=await query(`SELECT id,status,language,subject,last_message_at,first_message_at,created_at,updated_at FROM omni_conversations WHERE workspace_id=$1 AND id=$2`,[workspaceId,id]);
  if(!row.rows[0]) return null;
  const messages=await query(`SELECT id,direction,sender_type,message_type,text_content,status,sent_at,received_at,delivered_at,read_at,created_at
    FROM omni_messages
    WHERE workspace_id=$1 AND conversation_id=$2 AND direction <> 'INTERNAL' AND message_type <> 'INTERNAL_NOTE'
    ORDER BY created_at ASC LIMIT 500`,[workspaceId,id]);
  const conversation=row.rows[0];
  return {
    conversation:{id:conversation.id,status:conversation.status,language:conversation.language??null,subject:conversation.subject??null,lastMessageAt:conversation.last_message_at??null,firstMessageAt:conversation.first_message_at??null,createdAt:conversation.created_at,updatedAt:conversation.updated_at},
    messages:messages.rows.map(mapPublicMessage),
  };
}

export async function getAdminConversation(id:string) {
  const row=await query(`SELECT c.*,ch.display_name channel_display_name,ci.display_name identity_display_name,w.name workspace_name FROM omni_conversations c JOIN omni_channels ch ON ch.id=c.channel_id JOIN omni_channel_identities ci ON ci.id=c.channel_identity_id JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=$1`,[id]);
  if(!row.rows[0]) return null;
  const messages=await query(`SELECT * FROM omni_messages WHERE conversation_id=$1 ORDER BY created_at ASC LIMIT 500`,[id]);
  const participants=await query(`SELECT * FROM omni_conversation_participants WHERE conversation_id=$1 ORDER BY created_at`,[id]);
  return {conversation:{...mapConversation(row.rows[0]),workspaceName:row.rows[0].workspace_name},messages:messages.rows.map(mapMessage),participants:participants.rows};
}

export async function createConversation(input:{workspaceId:string;channelId:string;channelIdentityId:string;handlingMode?:string;language?:string;subject?:string;metadata?:Record<string,unknown>}, actorId?:string|null) {
  const r=await query(`INSERT INTO omni_conversations(workspace_id,channel_id,channel_identity_id,handling_mode,language,subject,metadata) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[input.workspaceId,input.channelId,input.channelIdentityId,input.handlingMode??'AI_AUTO',input.language??null,input.subject??null,input.metadata??{}]);
  const result=mapConversation(r.rows[0]); await appendDomainEvent({workspaceId:input.workspaceId,type:DOMAIN_EVENT_TYPES.CONVERSATION_CREATED,aggregateType:'conversation',aggregateId:result.id,payload:{channelId:input.channelId,channelIdentityId:input.channelIdentityId},metadata:{actorId:actorId??null,source:'omnichannel'}}); return result;
}

export async function createMessage(input:{workspaceId:string;conversationId:string;channelId:string;channelIdentityId:string;direction:'INBOUND'|'OUTBOUND'|'INTERNAL';senderType:string;senderUserId?:string|null;messageType:string;text:string;status?:string;clientMessageId?:string;providerMessageId?:string|null}, actorId?:string|null) {
  const existing=input.clientMessageId?await query(`SELECT * FROM omni_messages WHERE workspace_id=$1 AND conversation_id=$2 AND client_message_id=$3`,[input.workspaceId,input.conversationId,input.clientMessageId]):{rows:[]};
  if(existing.rows[0]) return mapMessage(existing.rows[0]);
  const r=await query(`INSERT INTO omni_messages(workspace_id,conversation_id,channel_id,channel_identity_id,direction,sender_type,sender_user_id,message_type,text_content,status,client_message_id,provider_message_id,sent_at,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $5='OUTBOUND' THEN NOW() END,CASE WHEN $5='INBOUND' THEN NOW() END) RETURNING *`,[input.workspaceId,input.conversationId,input.channelId,input.channelIdentityId,input.direction,input.senderType,input.senderUserId??null,input.messageType,input.text,input.status??(input.direction==='INBOUND'?'RECEIVED':'QUEUED'),input.clientMessageId??null,input.providerMessageId??null]);
  await query(`UPDATE omni_conversations SET last_message_at=NOW(),first_message_at=COALESCE(first_message_at,NOW()),updated_at=NOW(),version=version+1 WHERE workspace_id=$1 AND id=$2`,[input.workspaceId,input.conversationId]);
  const msg=mapMessage(r.rows[0]); await appendDomainEvent({workspaceId:input.workspaceId,type:input.direction==='INBOUND'?DOMAIN_EVENT_TYPES.MESSAGE_RECEIVED:input.direction==='INTERNAL'?DOMAIN_EVENT_TYPES.MESSAGE_QUEUED:DOMAIN_EVENT_TYPES.MESSAGE_QUEUED,aggregateType:'message',aggregateId:msg.id,payload:{conversationId:input.conversationId,status:msg.status,direction:input.direction},metadata:{actorId:actorId??null,source:'omnichannel'}}); return msg;
}

export async function updateConversation(workspaceId:string,id:string,input:Record<string,unknown>,actorId:string) {
  const fields:string[]=[];const params:any[]=[workspaceId,id]; for(const [key,col] of [['status','status'],['priority','priority'],['handlingMode','handling_mode'],['assignedUserId','assigned_user_id']] as const){if(Object.prototype.hasOwnProperty.call(input,key)){params.push(input[key]);fields.push(`${col}=$${params.length}`);}}
  if(!fields.length) return getConversation(workspaceId,id);
  fields.push('updated_at=NOW()','version=version+1'); const r=await query(`UPDATE omni_conversations SET ${fields.join(',')} WHERE workspace_id=$1 AND id=$2 RETURNING *`,params); if(!r.rows[0]) return null;
  await appendDomainEvent({workspaceId,type:input.status==='RESOLVED'?DOMAIN_EVENT_TYPES.CONVERSATION_RESOLVED:input.handlingMode==='HUMAN'?DOMAIN_EVENT_TYPES.CONVERSATION_HUMAN_TAKEOVER:input.handlingMode?DOMAIN_EVENT_TYPES.CONVERSATION_RETURNED_TO_AI:DOMAIN_EVENT_TYPES.CONVERSATION_STATUS_CHANGED,aggregateType:'conversation',aggregateId:id,payload:input,metadata:{actorId,source:'omnichannel'}}); return mapConversation(r.rows[0]);
}

export async function getWebsiteIdentityByWidget(widgetId:string) { const r=await query(`SELECT w.*,ci.channel_id,ci.workspace_id identity_workspace,ci.display_name identity_display_name,ci.status identity_status,ci.capabilities identity_capabilities FROM omni_website_chat_identities w JOIN omni_channel_identities ci ON ci.id=w.channel_identity_id WHERE w.public_widget_id=$1`,[widgetId]); return r.rows[0]??null; }
export async function createWebsiteIdentity(workspaceId:string,input:{websiteId:string;welcomeMessage?:string;supportedLanguages?:string[];defaultLanguage?:string;allowedOrigins?:string[]},actorId:string) {
  const channel=await query<{id:string}>(`SELECT id FROM omni_channels WHERE channel_type='WEBSITE_CHAT' AND provider='lulu'`); if(!channel.rows[0]) throw new Error('Website Chat channel is not configured');
  const identity=await query<{id:string}>(`INSERT INTO omni_channel_identities(channel_id,workspace_id,website_id,identity_type,external_identity_id,display_name,mode,status,default_language,capabilities) VALUES($1,$2,$3,'WEBSITE','website:'||$3,'Website Chat','LULU_MANAGED','ACTIVE',$4,$5) ON CONFLICT(channel_id,external_identity_id) DO UPDATE SET updated_at=NOW() RETURNING id`,[channel.rows[0]!.id,workspaceId,input.websiteId,input.defaultLanguage??'en',JSON.stringify({'messages.read':true,'messages.send':true,'messages.inbound_webhook':true})]);
  const r=await query(`INSERT INTO omni_website_chat_identities(workspace_id,website_id,channel_identity_id,welcome_message,supported_languages,default_language,allowed_origins) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,website_id) DO UPDATE SET welcome_message=EXCLUDED.welcome_message,supported_languages=EXCLUDED.supported_languages,default_language=EXCLUDED.default_language,allowed_origins=EXCLUDED.allowed_origins,updated_at=NOW() RETURNING *`,[workspaceId,input.websiteId,identity.rows[0]!.id,input.welcomeMessage??'Hello! How can we help you today?',input.supportedLanguages??['en'],input.defaultLanguage??'en',input.allowedOrigins??[]]);
  await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.CHANNEL_IDENTITY_CREATED,aggregateType:'channel_identity',aggregateId:identity.rows[0]!.id,payload:{websiteId:input.websiteId},metadata:{actorId,source:'omnichannel'}}); return {...r.rows[0],channelIdentityId:identity.rows[0]!.id};
}

export async function createPublicSession(widgetId:string, origin?:string, visitorId?:string, pageContext?:Record<string,unknown>) {
  const identity=await getWebsiteIdentityByWidget(widgetId); if(!identity || identity.status!=='ACTIVE' || identity.identity_status!=='ACTIVE') return null;
  const origins=(identity.allowed_origins??[]) as string[];
  // Browser origins must be explicitly allowlisted. Requests without an
  // Origin header remain supported for same-origin/server-side integrations.
  if(origin && (!origins.length || !origins.includes(origin))) return null;
  const conversation=await createConversation({workspaceId:identity.workspace_id,channelId:identity.channel_id,channelIdentityId:identity.channel_identity_id,handlingMode:identity.ai_handling_mode,language:identity.default_language,metadata:{pageContext:pageContext??{}}});
  const token=randomBytes(32).toString('hex'); await query(`INSERT INTO omni_website_chat_sessions(website_chat_identity_id,workspace_id,conversation_id,token_hash,visitor_id,metadata) VALUES($1,$2,$3,$4,$5,$6)`,[identity.id,identity.workspace_id,conversation.id,hashToken(token),visitorId??null,pageContext??{}]);
  await appendDomainEvent({workspaceId:identity.workspace_id,type:DOMAIN_EVENT_TYPES.WEBSITE_CHAT_SESSION_STARTED,aggregateType:'website_chat_session',aggregateId:conversation.id,payload:{websiteChatIdentityId:identity.id},metadata:{source:'omnichannel.public'}});
  return {sessionToken:token,conversationId:conversation.id,welcomeMessage:identity.welcome_message,defaultLanguage:identity.default_language,supportedLanguages:identity.supported_languages};
}
export async function getPublicSession(token:string) { const r=await query(`SELECT s.*,w.welcome_message,w.default_language,w.supported_languages FROM omni_website_chat_sessions s JOIN omni_website_chat_identities w ON w.id=s.website_chat_identity_id JOIN omni_channel_identities ci ON ci.id=w.channel_identity_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND w.status='ACTIVE' AND ci.status='ACTIVE'`,[hashToken(token)]); return r.rows[0]??null; }
export async function listRoutingQueue() { const r=await query(`SELECT q.*,ci.display_name identity_display_name,c.channel_type FROM omni_routing_queue q JOIN omni_channel_identities ci ON ci.id=q.channel_identity_id JOIN omni_channels c ON c.id=ci.channel_id WHERE q.status='UNRESOLVED' ORDER BY q.created_at ASC LIMIT 200`); return r.rows; }
export async function listAdminConversations(filters:{workspaceId?:string;status?:string;limit?:number;search?:string}) { const params:any[]=[]; const where:string[]=[]; if(filters.workspaceId){params.push(filters.workspaceId);where.push(`c.workspace_id=$${params.length}`);} if(filters.status){params.push(filters.status);where.push(`c.status=$${params.length}`);} if(filters.search){params.push(`%${filters.search}%`);where.push(`(c.subject ILIKE $${params.length} OR w.name ILIKE $${params.length} OR ch.display_name ILIKE $${params.length} OR EXISTS(SELECT 1 FROM omni_messages sm WHERE sm.conversation_id=c.id AND sm.text_content ILIKE $${params.length}))`);} params.push(Math.min(filters.limit??100,200)); const r=await query(`SELECT c.*,ch.display_name channel_display_name,ci.display_name identity_display_name,w.name workspace_name FROM omni_conversations c JOIN omni_channels ch ON ch.id=c.channel_id JOIN omni_channel_identities ci ON ci.id=c.channel_identity_id JOIN workspaces w ON w.id=c.workspace_id ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY c.last_message_at DESC NULLS LAST LIMIT $${params.length}`,params); return r.rows.map(mapConversation).map((v:any,i:number)=>({...v,workspaceName:r.rows[i]!.workspace_name})); }
export async function adminResolveRouting(id:string,workspaceId:string,adminId:string,reason:string) { const r=await query(`UPDATE omni_routing_queue SET status='ASSIGNED',resolved_workspace_id=$2,resolved_by=$3,resolved_at=NOW() WHERE id=$1 AND status='UNRESOLVED' RETURNING *`,[id,workspaceId,adminId]); if(!r.rows[0]) return null; await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.ROUTING_DECISION_RESOLVED,aggregateType:'routing_queue',aggregateId:id,payload:{reason},metadata:{actorId:adminId,source:'admin'}}); return r.rows[0]; }
export async function analytics(workspaceId:string) { const r=await query(`SELECT count(*)::int total_conversations,count(*) FILTER(WHERE created_at>=NOW()-INTERVAL '30 days')::int new_conversations,count(*) FILTER(WHERE handling_mode IN ('AI_AUTO','AI_ASSISTED'))::int ai_handled,count(*) FILTER(WHERE handling_mode IN ('HUMAN','ESCALATED'))::int human_handled,count(*) FILTER(WHERE status='RESOLVED')::int resolved FROM omni_conversations WHERE workspace_id=$1`,[workspaceId]); return r.rows[0]??{total_conversations:0,new_conversations:0,ai_handled:0,human_handled:0,resolved:0}; }
