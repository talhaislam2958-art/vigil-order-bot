ALTER TABLE public.bot_users
  ADD COLUMN IF NOT EXISTS amount_mode text NOT NULL DEFAULT 'range',
  ADD COLUMN IF NOT EXISTS specific_amounts numeric[] NOT NULL DEFAULT '{}'::numeric[];

ALTER TABLE public.bot_users
  ADD CONSTRAINT bot_users_amount_mode_check CHECK (amount_mode IN ('range','specific'));