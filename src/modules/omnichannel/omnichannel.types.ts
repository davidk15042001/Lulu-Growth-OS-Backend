export type OmniStatus = 'OPEN'|'ACTIVE'|'WAITING_CUSTOMER'|'WAITING_LULU'|'ESCALATED'|'RESOLVED'|'CLOSED'|'SPAM';
export type HandlingMode = 'AI_AUTO'|'AI_ASSISTED'|'HUMAN'|'ESCALATED';
export type MessageStatus = 'QUEUED'|'SENDING'|'SENT'|'DELIVERED'|'READ'|'FAILED'|'RECEIVED';
export type ChannelType = 'EMAIL'|'WEBSITE_CHAT'|'WHATSAPP'|'FACEBOOK_MESSENGER'|'INSTAGRAM'|'WECHAT'|'SMS'|'OTHER';

export type OmniChannel = { id:string; channelType:ChannelType; provider:string; status:string; displayName:string; capabilities:Record<string,boolean>; };
export type ChannelIdentity = { id:string; channelId:string; workspaceId:string|null; websiteId:string|null; identityType:string; externalIdentityId:string; displayName:string; mode:string; status:string; defaultLanguage:string|null; capabilities:Record<string,boolean>; };
export type Conversation = { id:string; workspaceId:string; channelId:string; channelIdentityId:string; status:OmniStatus; priority:string; handlingMode:HandlingMode; language:string|null; subject:string|null; assignedUserId:string|null; primaryProductId:string|null; lastMessageAt:string|null; firstMessageAt:string|null; createdAt:string; updatedAt:string; messageCount?:number; unreadCount?:number; channelDisplayName?:string; identityDisplayName?:string; };
export type Message = { id:string; conversationId:string; workspaceId:string; direction:string; senderType:string; messageType:string; textContent:string|null; status:MessageStatus; providerMessageId:string|null; clientMessageId:string|null; sentAt:string|null; receivedAt:string|null; deliveredAt:string|null; readAt:string|null; failedAt:string|null; createdAt:string; };
