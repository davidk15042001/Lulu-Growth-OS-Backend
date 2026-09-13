import { notFoundError } from '../../utils/app-error.js';
import { assertWorkspaceCapability } from '../workspaces/workspace-authorization.service.js';
import * as repo from './journal.repo.js';

async function authorize(workspaceId:string,userId:string){await assertWorkspaceCapability({workspaceId,userId,capability:'finance.read'});}

export async function listJournals(workspaceId:string,userId:string,filters:Parameters<typeof repo.listJournals>[1]){await authorize(workspaceId,userId);return repo.listJournals(workspaceId,filters);}
export async function getJournal(workspaceId:string,userId:string,journalId:string){await authorize(workspaceId,userId);const journal=await repo.getJournal(workspaceId,journalId);if(!journal)throw notFoundError('Journal not found');return journal;}
export async function getAccountBalance(workspaceId:string,userId:string,accountCode:string,currency:string,asOf?:string){await authorize(workspaceId,userId);return repo.getAccountBalance(workspaceId,accountCode,currency,asOf);}
export async function getTrialBalance(workspaceId:string,userId:string,currency:string,asOf?:string){await authorize(workspaceId,userId);return repo.getTrialBalance(workspaceId,currency,asOf);}
