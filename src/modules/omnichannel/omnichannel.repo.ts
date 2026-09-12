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
    FROM omni_channels c LEFT JOIN omni_channel_identities ci ON ci.channel_id=c.id AND ${workspaceId==='__ADMIN__'?'TRUE':`(ci.workspace_id=$1 OR (ci.workspace_id IS NULL AND ci.id=(SELECT admin_whatsapp_identity_id FROM twilio_platform_configuration WHERE singleton=TRUE)))`}
    WHERE c.channel_type NOT IN ('WECHAT','SMS')
      AND NOT (c.channel_type IN ('WHATSAPP','FACEBOOK_MESSENGER') AND c.provider <> 'twilio')
    GROUP BY c.id ORDER BY c.display_name`,workspaceId==='__ADMIN__'?[]:[workspaceId]);
  const result=rows.map((r:any)=>({id:r.id,channelType:r.channel_type,provider:r.provider,status:r.status,displayName:r.display_name,capabilities:r.capabilities,identities:r.identities}));
  if(workspaceId!=='__ADMIN__') {
    const accounts=await query(`SELECT id,email_address,display_name,status FROM email_accounts WHERE workspace_id=$1 AND status <> 'disconnected' ORDER BY updated_at DESC`,[workspaceId]);
    const email=result.find((item:any)=>item.channelType==='EMAIL');
    if(email && accounts.rows.length){email.status='ACTIVE'; email.identities.push(...accounts.rows.map((account:any)=>({id:`email-account:${account.id}`,workspaceId,websiteId:null,identityType:'MAILBOX',externalIdentityId:account.email_address,displayName:account.display_name||account.email_address,mode:'CUSTOMER_OWNED',status:account.status==='reauth_required'?'AUTHORIZATION_REQUIRED':'ACTIVE',defaultLanguage:null,capabilities:{'messages.read':true,'messages.send':account.status==='connected'}})));}
  }
  return result;
}

export async function resolvePreferredOutboundIdentity(workspaceId:string,channelType:string) {
  const {rows}=await query<{channelId:string;channelIdentityId:string;mode:string}>(
    `SELECT ch.id AS "channelId",ci.id AS "channelIdentityId",ci.mode
       FROM omni_channel_identities ci JOIN omni_channels ch ON ch.id=ci.channel_id
      WHERE ci.status='ACTIVE' AND ch.status='ACTIVE' AND ch.channel_type=$2
        AND (ci.workspace_id=$1 OR (
          ci.workspace_id IS NULL AND ci.id=(
            SELECT admin_whatsapp_identity_id FROM twilio_platform_configuration WHERE singleton=TRUE
          )
        ))
        AND COALESCE((ci.capabilities->>'messages.send')::boolean,FALSE)=TRUE
      ORDER BY CASE WHEN ci.workspace_id=$1 THEN 0 ELSE 1 END,ci.updated_at DESC
      LIMIT 1`,
    [workspaceId,channelType],
  );
  return rows[0]??null;
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

export async function getConversationTransport(workspaceId:string,id:string) {
  const result=await query<{
    conversationId:string;channelId:string;channelIdentityId:string;channelType:string;provider:string;
    identityStatus:string;externalIdentityId:string;identityMetadata:Record<string,unknown>;conversationMetadata:Record<string,unknown>;
  }>(`SELECT c.id AS "conversationId",c.channel_id AS "channelId",c.channel_identity_id AS "channelIdentityId",
      ch.channel_type AS "channelType",ch.provider,ci.status AS "identityStatus",ci.external_identity_id AS "externalIdentityId",
      ci.metadata AS "identityMetadata",c.metadata AS "conversationMetadata"
    FROM omni_conversations c JOIN omni_channels ch ON ch.id=c.channel_id
      JOIN omni_channel_identities ci ON ci.id=c.channel_identity_id
    WHERE c.workspace_id=$1 AND c.id=$2`,[workspaceId,id]);
  if(!result.rows[0]) return null;
  const participant=await query<{participantKey:string;metadata:Record<string,unknown>}>(
    `SELECT participant_key AS "participantKey",metadata FROM omni_conversation_participants
      WHERE workspace_id=$1 AND conversation_id=$2 AND participant_type IN ('PARTY','CONTACT') ORDER BY created_at LIMIT 1`,
    [workspaceId,id],
  );
  return {...result.rows[0],recipient:participant.rows[0]??null};
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

export async function createMessage(input:{workspaceId:string;conversationId:string;channelId:string;channelIdentityId:string;direction:'INBOUND'|'OUTBOUND'|'INTERNAL';senderType:string;senderUserId?:string|null;messageType:string;text:string;status?:string;clientMessageId?:string;providerMessageId?:string|null;metadata?:Record<string,unknown>}, actorId?:string|null) {
  const existing=input.clientMessageId?await query(`SELECT * FROM omni_messages WHERE workspace_id=$1 AND conversation_id=$2 AND client_message_id=$3`,[input.workspaceId,input.conversationId,input.clientMessageId]):{rows:[]};
  if(existing.rows[0]) return mapMessage(existing.rows[0]);
  const r=await query(`INSERT INTO omni_messages(workspace_id,conversation_id,channel_id,channel_identity_id,direction,sender_type,sender_user_id,message_type,text_content,status,client_message_id,provider_message_id,metadata,sent_at,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $5='OUTBOUND' THEN NOW() END,CASE WHEN $5='INBOUND' THEN NOW() END) ON CONFLICT DO NOTHING RETURNING *`,[input.workspaceId,input.conversationId,input.channelId,input.channelIdentityId,input.direction,input.senderType,input.senderUserId??null,input.messageType,input.text,input.status??(input.direction==='INBOUND'?'RECEIVED':'QUEUED'),input.clientMessageId??null,input.providerMessageId??null,input.metadata??{}]);
  if(!r.rows[0]) {
    const raced=input.clientMessageId
      ? await query(`SELECT * FROM omni_messages WHERE workspace_id=$1 AND conversation_id=$2 AND client_message_id=$3`,[input.workspaceId,input.conversationId,input.clientMessageId])
      : input.providerMessageId
        ? await query(`SELECT * FROM omni_messages WHERE channel_identity_id=$1 AND provider_message_id=$2`,[input.channelIdentityId,input.providerMessageId])
        : {rows:[]};
    if(raced.rows[0])return mapMessage(raced.rows[0]);
    throw new Error('OmniChannel message could not be persisted.');
  }
  await query(`UPDATE omni_conversations SET last_message_at=NOW(),first_message_at=COALESCE(first_message_at,NOW()),updated_at=NOW(),version=version+1 WHERE workspace_id=$1 AND id=$2`,[input.workspaceId,input.conversationId]);
  const msg=mapMessage(r.rows[0]);
  if(input.direction==='INBOUND')await query(`INSERT INTO omni_ai_reply_jobs(message_id,workspace_id,conversation_id) VALUES($1,$2,$3) ON CONFLICT(message_id) DO NOTHING`,[msg.id,input.workspaceId,input.conversationId]);
  await appendDomainEvent({workspaceId:input.workspaceId,type:input.direction==='INBOUND'?DOMAIN_EVENT_TYPES.MESSAGE_RECEIVED:input.direction==='INTERNAL'?DOMAIN_EVENT_TYPES.MESSAGE_QUEUED:DOMAIN_EVENT_TYPES.MESSAGE_QUEUED,aggregateType:'message',aggregateId:msg.id,payload:{conversationId:input.conversationId,status:msg.status,direction:input.direction},metadata:{actorId:actorId??null,source:'omnichannel'}}); return msg;
}

export async function claimAiReplyJob(messageId:string) {
  const {rows}=await query<{messageId:string;workspaceId:string;conversationId:string}>(`UPDATE omni_ai_reply_jobs SET status='PROCESSING',attempts=attempts+1,locked_at=NOW(),updated_at=NOW()
    WHERE message_id=$1 AND (status IN ('PENDING','WAITING_FUNDS') OR (status='PROCESSING' AND locked_at<NOW()-INTERVAL '5 minutes'))
    RETURNING message_id AS "messageId",workspace_id AS "workspaceId",conversation_id AS "conversationId"`,[messageId]);
  return rows[0]??null;
}

export async function markAiReplyJob(messageId:string,status:'PENDING'|'WAITING_FUNDS'|'SUCCEEDED'|'FAILED',error?:string|null) {
  await query(`UPDATE omni_ai_reply_jobs SET status=$2,last_error=$3,locked_at=NULL,updated_at=NOW() WHERE message_id=$1`,[messageId,status,error??null]);
}

export async function listWaitingAiReplyMessageIds(workspaceId:string,limit=100) {
  const {rows}=await query<{messageId:string}>(`SELECT message_id AS "messageId" FROM omni_ai_reply_jobs
    WHERE workspace_id=$1 AND status IN ('PENDING','WAITING_FUNDS') ORDER BY created_at LIMIT $2`,[workspaceId,limit]);
  return rows.map(row=>row.messageId);
}

export async function updateMessageDeliveryState(workspaceId:string,messageId:string,input:{status:'SENDING'|'SENT'|'DELIVERED'|'READ'|'FAILED';providerMessageId?:string|null;errorCode?:string|null}) {
  const {rows}=await query(`UPDATE omni_messages SET
    status=$3,
    provider_message_id=COALESCE($4,provider_message_id),
    error_code=$5,
    sent_at=CASE WHEN $3 IN ('SENT','DELIVERED','READ') THEN COALESCE(sent_at,NOW()) ELSE sent_at END,
    delivered_at=CASE WHEN $3 IN ('DELIVERED','READ') THEN COALESCE(delivered_at,NOW()) ELSE delivered_at END,
    read_at=CASE WHEN $3='READ' THEN COALESCE(read_at,NOW()) ELSE read_at END,
    failed_at=CASE WHEN $3='FAILED' THEN COALESCE(failed_at,NOW()) ELSE failed_at END
    WHERE workspace_id=$1 AND id=$2 RETURNING *`,[workspaceId,messageId,input.status,input.providerMessageId??null,input.errorCode??null]);
  return rows[0]?mapMessage(rows[0]):null;
}

export async function registerTwilioIdentity(input:{workspaceId:string;channelType:'WHATSAPP'|'FACEBOOK_MESSENGER';address:string;displayName:string;defaultLanguage?:string|null}) {
  const {rows}=await query(`INSERT INTO omni_channel_identities(
      channel_id,workspace_id,identity_type,external_identity_id,display_name,mode,status,default_language,capabilities,metadata
    ) SELECT id,$1,$2,$3,$4,'LULU_MANAGED','ACTIVE',$5,
      '{"messages.read":true,"messages.send":true,"messages.inbound_webhook":true,"messages.delivery_status":true}'::jsonb,
      '{"provider":"twilio"}'::jsonb
    FROM omni_channels WHERE channel_type=$2 AND provider='twilio' AND status='ACTIVE'
    ON CONFLICT(channel_id,external_identity_id) DO UPDATE SET
      display_name=EXCLUDED.display_name,status='ACTIVE',default_language=EXCLUDED.default_language,updated_at=NOW()
    WHERE omni_channel_identities.workspace_id=EXCLUDED.workspace_id
    RETURNING *`,[input.workspaceId,input.channelType,input.address,input.displayName,input.defaultLanguage??null]);
  return rows[0]??null;
}

export async function ingestTwilioInbound(input:{messageSid:string;from:string;to:string;body:string;messageType:string;metadata:Record<string,unknown>}) {
  const identity=await query<{id:string;workspaceId:string|null;channelId:string;defaultLanguage:string|null}>(`SELECT ci.id,ci.workspace_id AS "workspaceId",ci.channel_id AS "channelId",ci.default_language AS "defaultLanguage"
    FROM omni_channel_identities ci JOIN omni_channels ch ON ch.id=ci.channel_id
    WHERE ch.provider='twilio' AND lower(ci.external_identity_id)=lower($1) AND ci.status='ACTIVE'
    LIMIT 1`,[input.to]);
  const route=identity.rows[0];
  if(!route)return {routed:false,reason:'TWILIO_IDENTITY_NOT_REGISTERED'} as const;
  let routedWorkspaceId=route.workspaceId;
  let conversationId:string|null=null;
  if(route.workspaceId===null){
    const repliedToSid=typeof input.metadata.OriginalRepliedMessageSid==='string'?input.metadata.OriginalRepliedMessageSid.trim():'';
    const replyCandidate=repliedToSid?(await query<{conversationId:string;workspaceId:string}>(`SELECT c.id AS "conversationId",c.workspace_id AS "workspaceId"
      FROM omni_messages m JOIN omni_conversations c ON c.id=m.conversation_id AND c.workspace_id=m.workspace_id
      WHERE m.channel_identity_id=$1 AND m.provider_message_id=$2 AND m.direction='OUTBOUND'
      ORDER BY m.created_at DESC LIMIT 2`,[route.id,repliedToSid])).rows:[];
    const candidates=replyCandidate.length?replyCandidate:await query<{conversationId:string;workspaceId:string}>(`SELECT c.id AS "conversationId",c.workspace_id AS "workspaceId"
      FROM omni_conversations c JOIN omni_conversation_participants p ON p.conversation_id=c.id AND p.workspace_id=c.workspace_id
      WHERE c.channel_identity_id=$1 AND c.status NOT IN ('CLOSED','SPAM')
        AND lower(COALESCE(p.metadata->>'externalId',p.participant_key))=lower($2)
      ORDER BY c.updated_at DESC LIMIT 3`,[route.id,input.from]);
    let candidateRows=Array.isArray(candidates)?candidates:candidates.rows;
    if(!candidateRows.length){
      const crmCandidates=await query<{workspaceId:string}>(`SELECT DISTINCT r.workspace_id AS "workspaceId"
        FROM workspace_records r JOIN workspaces w ON w.id=r.workspace_id AND w.deleted_at IS NULL
        WHERE r.deleted_at IS NULL AND r.resource_type IN ('crm_companies','crm_contacts','customers','ecommerce_customers')
          AND (
            regexp_replace(COALESCE(r.data->>'phone',r.data->>'phoneNumber',r.data->>'mobile',r.external_id,''),'[^0-9]','','g')=regexp_replace($1,'[^0-9]','','g')
            OR (char_length(trim(w.name))>=3 AND position(lower(w.name) in lower($2))>0)
          ) LIMIT 3`,[input.from,input.body]);
      candidateRows=crmCandidates.rows.map((item)=>({workspaceId:item.workspaceId,conversationId:''}));
    }
    const workspaceIds=[...new Set(candidateRows.map(item=>item.workspaceId))];
    if(workspaceIds.length===1){routedWorkspaceId=workspaceIds[0]!;conversationId=candidateRows.find((item)=>item.conversationId)?.conversationId||null;}
    else{
      await query(`INSERT INTO omni_routing_queue(channel_identity_id,provider_event_id,provider_message_id,external_sender_key,message_preview,context,confidence,reason,evidence)
        VALUES($1,$2,$2,$3,$4,$5::jsonb,'UNRESOLVED',$6,$7::jsonb)
        ON CONFLICT(channel_identity_id,provider_message_id) DO NOTHING`,[
          route.id,input.messageSid,input.from,input.body.slice(0,8000),JSON.stringify({
            to:input.to,
            messageType:input.messageType,
            mediaCount:input.metadata.NumMedia??'0',
            mediaUrl:input.metadata.MediaUrl0??null,
            mediaContentType:input.metadata.MediaContentType0??null,
          }),
          workspaceIds.length>1?'Shared sender has multiple active workspace matches':'Shared sender has no deterministic workspace match',
          JSON.stringify({candidateWorkspaceCount:workspaceIds.length}),
        ]);
      return {routed:false,reason:workspaceIds.length>1?'TWILIO_SHARED_SENDER_AMBIGUOUS':'TWILIO_SHARED_SENDER_UNROUTED'} as const;
    }
  }
  if(!routedWorkspaceId)return {routed:false,reason:'TWILIO_WORKSPACE_ROUTE_MISSING'} as const;
  if(!conversationId){
    const conversation=await query(`INSERT INTO omni_conversations(workspace_id,channel_id,channel_identity_id,handling_mode,language,subject,provider_thread_key,metadata)
      VALUES($1,$2,$3,'AI_AUTO',$4,'Twilio conversation',$5,$6)
      ON CONFLICT(workspace_id,channel_identity_id,provider_thread_key) WHERE provider_thread_key IS NOT NULL
      DO UPDATE SET updated_at=NOW() RETURNING *`,[routedWorkspaceId,route.channelId,route.id,route.defaultLanguage,input.from,JSON.stringify({externalSenderKey:input.from,provider:'twilio'})]);
    conversationId=String(conversation.rows[0]!.id);
  }
  await query(`INSERT INTO omni_conversation_participants(workspace_id,conversation_id,participant_type,participant_key,metadata)
    VALUES($1,$2,'PARTY',$3,$4) ON CONFLICT(conversation_id,participant_type,participant_key) DO NOTHING`,[routedWorkspaceId,conversationId,input.from,JSON.stringify({externalId:input.from,provider:'twilio',recipientType:'user'})]);
  const existing=await query(`SELECT * FROM omni_messages WHERE channel_identity_id=$1 AND provider_message_id=$2`,[route.id,input.messageSid]);
  if(existing.rows[0])return {routed:true,duplicate:true,workspaceId:routedWorkspaceId,conversationId,message:mapMessage(existing.rows[0])} as const;
  const message=await createMessage({workspaceId:routedWorkspaceId,conversationId,channelId:route.channelId,channelIdentityId:route.id,direction:'INBOUND',senderType:'BUYER',messageType:input.messageType,text:input.body,status:'RECEIVED',clientMessageId:`twilio:${input.messageSid}`,providerMessageId:input.messageSid,metadata:{provider:'twilio',mediaCount:input.metadata.NumMedia??'0',mediaUrl:input.metadata.MediaUrl0??null,mediaContentType:input.metadata.MediaContentType0??null}});
  return {routed:true,duplicate:false,workspaceId:routedWorkspaceId,conversationId,message} as const;
}

export async function updateTwilioMessageStatus(messageSid:string,status:string,errorCode?:string|null) {
  const mapped=status==='read'?'READ':status==='delivered'?'DELIVERED':status==='sent'?'SENT':status==='failed'||status==='undelivered'?'FAILED':status==='sending'?'SENDING':null;
  if(!mapped)return null;
  const {rows}=await query(`UPDATE omni_messages SET status=$2,error_code=$3,
      sent_at=CASE WHEN $2 IN ('SENT','DELIVERED','READ') THEN COALESCE(sent_at,NOW()) ELSE sent_at END,
      delivered_at=CASE WHEN $2 IN ('DELIVERED','READ') THEN COALESCE(delivered_at,NOW()) ELSE delivered_at END,
      read_at=CASE WHEN $2='READ' THEN COALESCE(read_at,NOW()) ELSE read_at END,
      failed_at=CASE WHEN $2='FAILED' THEN COALESCE(failed_at,NOW()) ELSE failed_at END
    WHERE provider_message_id=$1 RETURNING *`,[messageSid,mapped,errorCode??null]);
  return rows[0]?mapMessage(rows[0]):null;
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
export async function adminResolveRouting(id:string,workspaceId:string,adminId:string,reason:string) {
  const item=await query<{
    id:string;channelIdentityId:string;channelId:string;providerMessageId:string|null;
    externalSenderKey:string|null;messagePreview:string|null;context:Record<string,unknown>;
  }>(`SELECT q.id,q.channel_identity_id AS "channelIdentityId",ci.channel_id AS "channelId",
      q.provider_message_id AS "providerMessageId",q.external_sender_key AS "externalSenderKey",
      q.message_preview AS "messagePreview",q.context
    FROM omni_routing_queue q JOIN omni_channel_identities ci ON ci.id=q.channel_identity_id
    JOIN workspaces w ON w.id=$2 AND w.deleted_at IS NULL
    WHERE q.id=$1 AND q.status='UNRESOLVED' AND ci.status='ACTIVE'`,[id,workspaceId]);
  const route=item.rows[0];
  if(!route?.providerMessageId||!route.externalSenderKey)return null;
  const conversation=await query<{id:string}>(`INSERT INTO omni_conversations(
      workspace_id,channel_id,channel_identity_id,handling_mode,subject,provider_thread_key,metadata
    ) VALUES($1,$2,$3,'AI_AUTO','Twilio conversation',$4,$5::jsonb)
    ON CONFLICT(workspace_id,channel_identity_id,provider_thread_key) WHERE provider_thread_key IS NOT NULL
    DO UPDATE SET updated_at=NOW() RETURNING id`,[
      workspaceId,route.channelId,route.channelIdentityId,route.externalSenderKey,
      JSON.stringify({externalSenderKey:route.externalSenderKey,provider:'twilio',routingQueueId:id}),
    ]);
  const conversationId=conversation.rows[0]!.id;
  await query(`INSERT INTO omni_conversation_participants(workspace_id,conversation_id,participant_type,participant_key,metadata)
    VALUES($1,$2,'PARTY',$3,$4::jsonb) ON CONFLICT(conversation_id,participant_type,participant_key) DO NOTHING`,[
      workspaceId,conversationId,route.externalSenderKey,JSON.stringify({externalId:route.externalSenderKey,provider:'twilio',recipientType:'user'}),
    ]);
  const context=route.context??{};
  const message=await createMessage({
    workspaceId,conversationId,channelId:route.channelId,channelIdentityId:route.channelIdentityId,
    direction:'INBOUND',senderType:'BUYER',messageType:typeof context.messageType==='string'?context.messageType:'TEXT',
    text:route.messagePreview??'',status:'RECEIVED',clientMessageId:`twilio:${route.providerMessageId}`,
    providerMessageId:route.providerMessageId,metadata:{provider:'twilio',routedByAdmin:true,routingReason:reason,
      mediaCount:context.mediaCount??'0',mediaUrl:context.mediaUrl??null,mediaContentType:context.mediaContentType??null},
  });
  const resolved=await query(`UPDATE omni_routing_queue SET status='ASSIGNED',resolved_workspace_id=$2,
    resolved_by=$3,resolved_at=NOW(),evidence=evidence||$4::jsonb WHERE id=$1 AND status='UNRESOLVED' RETURNING *`,[
      id,workspaceId,adminId,JSON.stringify({reason,conversationId,messageId:message.id}),
    ]);
  if(!resolved.rows[0])return null;
  await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.ROUTING_DECISION_RESOLVED,aggregateType:'routing_queue',aggregateId:id,payload:{reason,conversationId,messageId:message.id},metadata:{actorId:adminId,source:'admin'}});
  return {...resolved.rows[0],conversationId,messageId:message.id};
}
export async function analytics(workspaceId:string) { const r=await query(`SELECT count(*)::int total_conversations,count(*) FILTER(WHERE created_at>=NOW()-INTERVAL '30 days')::int new_conversations,count(*) FILTER(WHERE handling_mode IN ('AI_AUTO','AI_ASSISTED'))::int ai_handled,count(*) FILTER(WHERE handling_mode IN ('HUMAN','ESCALATED'))::int human_handled,count(*) FILTER(WHERE status='RESOLVED')::int resolved FROM omni_conversations WHERE workspace_id=$1`,[workspaceId]); return r.rows[0]??{total_conversations:0,new_conversations:0,ai_handled:0,human_handled:0,resolved:0}; }
