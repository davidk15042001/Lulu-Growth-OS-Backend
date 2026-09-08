import { query, withTransaction } from '../../db/pool.js';
import { notFoundError } from '../../utils/app-error.js';

export type SupportActor = { userId: string; workspaceId: string } | { adminId: string };
function scope(actor: SupportActor) {
  return 'adminId' in actor ? { sql: 'TRUE', values: [] as string[] } :
    { sql: 'workspace_id=$1 AND requester_id=$2', values: [actor.workspaceId, actor.userId] };
}
export async function list(actor: SupportActor, limit: number, offset: number) {
  const access = scope(actor);
  return (await query(`SELECT t.id,t.subject,t.status,t.priority,t.category,
    t.workspace_id AS "workspaceId",w.name AS "workspaceName",t.updated_at AS "updatedAt"
    FROM (SELECT * FROM support_tickets WHERE ${access.sql}) t
    JOIN workspaces w ON w.id=t.workspace_id
    ORDER BY t.updated_at DESC,t.id LIMIT $${access.values.length+1} OFFSET $${access.values.length+2}`,
    [...access.values,limit,offset])).rows;
}
export async function detail(actor: SupportActor, id: string, limit=100, offset=0) {
  const access=scope(actor);
  const ticket=(await query(`SELECT id,workspace_id AS "workspaceId",subject,status,category,priority
    FROM support_tickets WHERE ${access.sql} AND id=$${access.values.length+1}`, [...access.values,id])).rows[0];
  if (!ticket) throw notFoundError('Support ticket not found');
  const messages=(await query(`SELECT id,author_type AS "authorType",body,created_at AS "createdAt"
    FROM support_messages WHERE workspace_id=$1 AND ticket_id=$2 ORDER BY created_at,id LIMIT $3 OFFSET $4`,
    [ticket.workspaceId,id,limit,offset])).rows;
  return {ticket,messages};
}
export async function create(workspaceId:string,userId:string,input:{subject:string;body:string;category:string}) {
  return withTransaction(async client=>{
    const ticket=(await client.query(`INSERT INTO support_tickets(workspace_id,requester_id,subject,category)
      VALUES($1,$2,$3,$4) RETURNING id`,[workspaceId,userId,input.subject,input.category])).rows[0];
    await client.query(`INSERT INTO support_messages(workspace_id,ticket_id,author_id,author_type,body)
      VALUES($1,$2,$3,'USER',$4)`,[workspaceId,ticket.id,userId,input.body]);
    await client.query(`INSERT INTO audit_log(workspace_id,actor_id,action,entity_type,entity_id)
      VALUES($1,$2,'support.created','support_ticket',$3)`,[workspaceId,userId,ticket.id]);
    return ticket;
  });
}
export async function respond(actor:SupportActor,id:string,input:{body?:string | undefined;status?:string | undefined}) {
  const access=scope(actor);
  return withTransaction(async client=>{
    const ticket=(await client.query(`SELECT * FROM support_tickets WHERE ${access.sql} AND id=$${access.values.length+1} FOR UPDATE`,[...access.values,id])).rows[0];
    if (!ticket) throw notFoundError('Support ticket not found');
    const admin='adminId' in actor;
    const userId=admin?actor.adminId:actor.userId;
    if (input.body) await client.query(`INSERT INTO support_messages(workspace_id,ticket_id,author_id,author_type,body)
      VALUES($1,$2,$3,$4,$5)`,[ticket.workspace_id,id,userId,admin?'ADMIN':'USER',input.body]);
    const status=admin?(input.status??'waiting_customer'):'open';
    await client.query(`UPDATE support_tickets SET status=$2,closed_at=CASE WHEN $2 IN ('closed','resolved') THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`,[id,status]);
    await client.query(`INSERT INTO audit_log(workspace_id,actor_id,action,entity_type,entity_id,after_data)
      VALUES($1,$2,'support.updated','support_ticket',$3,$4)`,[ticket.workspace_id,userId,id,JSON.stringify({status,actorType:admin?'ADMIN':'USER'})]);
    return {id,status};
  });
}
