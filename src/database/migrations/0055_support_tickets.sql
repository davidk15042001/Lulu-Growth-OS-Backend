-- Customer support is independent of a paid subscription, including billing help.
CREATE TABLE support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subject TEXT NOT NULL CHECK (char_length(trim(subject)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting_customer','resolved','closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general','billing','technical')),
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sla_due_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id)
);
CREATE INDEX support_tickets_requester ON support_tickets(workspace_id,requester_id,created_at DESC,id);
CREATE INDEX support_tickets_queue ON support_tickets(status,updated_at DESC,id);
CREATE TABLE support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  ticket_id UUID NOT NULL,
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('USER','ADMIN')),
  body TEXT NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,ticket_id) REFERENCES support_tickets(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX support_messages_history ON support_messages(workspace_id,ticket_id,created_at,id);
