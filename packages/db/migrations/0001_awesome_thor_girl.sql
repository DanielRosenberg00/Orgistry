CREATE TABLE "email_verification_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" text NOT NULL,
	"parent_token_id" text,
	"replacement_token_id" text,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"session_id" text,
	"organization_id" text,
	"actor_type" text NOT NULL,
	"event_type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"client_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_email_verification_tokens_token_hash" ON "email_verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_email_verification_tokens_user_id" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_refresh_tokens_token_hash" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_refresh_tokens_session_id" ON "refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ix_refresh_tokens_family_id" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "ix_security_events_user_id" ON "security_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_security_events_event_type" ON "security_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "ix_security_events_created_at" ON "security_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_expires_at" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_normalized_email" ON "users" USING btree ("normalized_email");