export type EmailProvider = 'google' | 'microsoft' | 'imap';

export type EmailAddress = {
  name?: string | null;
  address: string;
};

export type EmailAccount = {
  id: string;
  workspaceId: string;
  provider: EmailProvider;
  emailAddress: string;
  displayName: string | null;
  status: string;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EmailAccountCredential = EmailAccount & {
  connectedBy: string | null;
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: string | null;
  encryptedPassword: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
};

export type ProviderFolder = {
  providerFolderId: string;
  parentProviderFolderId?: string | null;
  name: string;
  systemName?: string | null;
  unreadCount: number;
  totalCount: number;
};

export type ProviderMessage = {
  providerMessageId: string;
  providerThreadId: string;
  internetMessageId?: string | null;
  direction: 'inbound' | 'outbound';
  sender: EmailAddress;
  recipients: EmailAddress[];
  ccRecipients: EmailAddress[];
  subject: string;
  preview: string;
  textBody: string;
  htmlBody?: string | null;
  providerFolderIds: string[];
  receivedAt?: string | null;
  sentAt?: string | null;
  isRead: boolean;
  starred: boolean;
};

export type SendEmailInput = {
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  bodyText: string;
  replyToProviderMessageId?: string | null;
  providerThreadId?: string | null;
  internetMessageId?: string | null;
};

export type ProviderSyncResult = {
  folders: ProviderFolder[];
  messages: ProviderMessage[];
  cursor?: string | null;
};
