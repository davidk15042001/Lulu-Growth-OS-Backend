import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { query } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { sendMail } from '../../utils/mailer.js';
import { sendAutonomousMessage } from '../omnichannel/omnichannel.service.js';

type Delivery = {
  id:string;workspaceId:string;documentType:'QUOTE'|'INVOICE';documentId:string;conversationId:string|null;
  channel:string;recipient:string|null;actorId:string|null;status:string;number:string;documentPath:string;attemptCount:number;
};

let timer:NodeJS.Timeout|undefined;
let cycleRunning=false;

function escapeHtml(value:string){return value.replace(/[&<>'"]/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]!));}

function absoluteDocumentUrl(path:string){
  if(/^https?:\/\//i.test(path))return path;
  const base=env.FRONTEND_BASE_URL?.replace(/\/$/,'');
  if(!base)throw new Error('FRONTEND_BASE_URL is required for commercial document delivery');
  return `${base}${path.startsWith('/')?'':'/'}${path}`;
}

async function loadAndClaim(deliveryId:string){
  return (await query<Delivery>(`UPDATE document_deliveries d SET status='SENDING',failure_reason=NULL,failed_at=NULL,attempt_count=d.attempt_count+1,next_attempt_at=NOW()+INTERVAL '15 minutes'
    FROM quotes q
    LEFT JOIN quote_versions qv ON qv.workspace_id=q.workspace_id AND qv.id=q.current_version_id
    WHERE d.id=$1 AND d.status IN ('QUEUED','FAILED') AND d.document_type='QUOTE'
      AND d.attempt_count<8 AND d.next_attempt_at<=NOW()
      AND q.workspace_id=d.workspace_id AND q.id=d.document_id
    RETURNING d.id,d.workspace_id AS "workspaceId",d.document_type AS "documentType",d.document_id AS "documentId",
      d.conversation_id AS "conversationId",d.channel,d.recipient,d.actor_id AS "actorId",d.status,d.attempt_count AS "attemptCount",
      q.quote_number AS number,qv.document_storage_reference AS "documentPath"`,[deliveryId])).rows[0]
    ??(await query<Delivery>(`UPDATE document_deliveries d SET status='SENDING',failure_reason=NULL,failed_at=NULL,attempt_count=d.attempt_count+1,next_attempt_at=NOW()+INTERVAL '15 minutes'
      FROM invoices i WHERE d.id=$1 AND d.status IN ('QUEUED','FAILED') AND d.document_type='INVOICE'
        AND d.attempt_count<8 AND d.next_attempt_at<=NOW()
        AND i.workspace_id=d.workspace_id AND i.id=d.document_id
      RETURNING d.id,d.workspace_id AS "workspaceId",d.document_type AS "documentType",d.document_id AS "documentId",
        d.conversation_id AS "conversationId",d.channel,d.recipient,d.actor_id AS "actorId",d.status,d.attempt_count AS "attemptCount",
        i.invoice_number AS number,i.document_storage_reference AS "documentPath"`,[deliveryId])).rows[0]??null;
}

export async function deliverCommercialDocument(deliveryId:string){
  const delivery=await loadAndClaim(deliveryId);
  if(!delivery)return {deliveryId,reused:true};
  try{
    if(!delivery.documentPath)throw new Error('Commercial document has no public storage reference');
    let providerMessageId:string|null=null;
    let messageId:string|null=null;
    if(delivery.channel==='email'){
      if(!delivery.recipient)throw new Error('Email delivery requires a recipient');
      const url=absoluteDocumentUrl(delivery.documentPath);
      const label=delivery.documentType==='QUOTE'?'Quote':'Invoice';
      await sendMail(delivery.recipient,`${label} ${delivery.number}`,`<p>Your ${label.toLowerCase()} <strong>${escapeHtml(delivery.number)}</strong> is ready.</p><p><a href="${escapeHtml(url)}">Open secure document</a></p>`);
    }else if(delivery.channel==='conversation'){
      if(!delivery.conversationId||!delivery.actorId)throw new Error('Conversation delivery requires a conversation and actor');
      const url=absoluteDocumentUrl(delivery.documentPath);
      const label=delivery.documentType==='QUOTE'?'Quote':'Invoice';
      const message=await sendAutonomousMessage(delivery.workspaceId,delivery.conversationId,delivery.actorId,{
        text:`${label} ${delivery.number} is ready: ${url}`,
        messageType:'TEXT',
        clientMessageId:`commercial-delivery:${delivery.id}`,
      });
      messageId=message.id;
      providerMessageId=message.providerMessageId;
    }else if(delivery.channel!=='secure_link'){
      throw new Error(`Unsupported commercial document delivery channel: ${delivery.channel}`);
    }
    await query(`UPDATE document_deliveries SET status='DELIVERED',message_id=COALESCE($2,message_id),provider_message_id=COALESCE($3,provider_message_id),sent_at=COALESCE(sent_at,NOW()),delivered_at=NOW(),failure_reason=NULL,failed_at=NULL,next_attempt_at=NOW() WHERE id=$1`,[delivery.id,messageId,providerMessageId]);
    return {deliveryId:delivery.id,status:'DELIVERED',channel:delivery.channel,providerMessageId};
  }catch(error){
    const message=error instanceof Error?error.message:'Commercial document delivery failed';
    const retryDelaySeconds=Math.min(3600,30*(2**Math.max(0,delivery.attemptCount-1)));
    await query(`UPDATE document_deliveries SET status='FAILED',failure_reason=$2,failed_at=NOW(),next_attempt_at=NOW()+($3*INTERVAL '1 second') WHERE id=$1`,[delivery.id,message.slice(0,2000),retryDelaySeconds]);
    await appendDomainEvent({workspaceId:delivery.workspaceId,type:delivery.documentType==='QUOTE'?DOMAIN_EVENT_TYPES.QUOTE_DELIVERY_FAILED:DOMAIN_EVENT_TYPES.INVOICE_DELIVERY_FAILED,aggregateType:'document_delivery',aggregateId:delivery.id,payload:{documentId:delivery.documentId,reason:message},metadata:{actorId:delivery.actorId,source:'commercial-document-delivery'}});
    throw error;
  }
}

async function runDeliveryCycle(){
  if(cycleRunning)return;
  cycleRunning=true;
  try{
    await query(`UPDATE document_deliveries SET status='FAILED',failure_reason='Delivery worker lease expired before completion.',failed_at=NOW(),next_attempt_at=NOW() WHERE status='SENDING' AND next_attempt_at<=NOW() AND attempt_count<8`);
    const rows=(await query<{id:string}>(`SELECT id FROM document_deliveries WHERE status IN ('QUEUED','FAILED') AND attempt_count<8 AND next_attempt_at<=NOW() ORDER BY next_attempt_at,created_at LIMIT 20`)).rows;
    for(const row of rows){try{await deliverCommercialDocument(row.id);}catch(error){logger.warn({error,deliveryId:row.id},'Commercial document delivery attempt failed');}}
  }finally{cycleRunning=false;}
}

export function startCommercialDocumentDeliveryWorker(){
  registerDomainEventHandler({name:'commercial-documents.delivery.v1',eventTypes:[DOMAIN_EVENT_TYPES.QUOTE_SENT,DOMAIN_EVENT_TYPES.INVOICE_SENT],async handle(event){
    const deliveryId=typeof event.payload.deliveryId==='string'?event.payload.deliveryId:null;
    return deliveryId?deliverCommercialDocument(deliveryId):{ignored:true};
  }});
  if(timer)return;
  timer=setInterval(()=>void runDeliveryCycle(),30_000);timer.unref();void runDeliveryCycle();
}

export function stopCommercialDocumentDeliveryWorker(){if(timer){clearInterval(timer);timer=undefined;}}
