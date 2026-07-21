CREATE TABLE "pending_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"invitation_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pending_registrations_token_hash" ON "pending_registrations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_pending_registrations_normalized_email" ON "pending_registrations" USING btree ("normalized_email");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pending_registrations_usable_email" ON "pending_registrations" USING btree ("normalized_email") WHERE used_at IS NULL AND invalidated_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_pending_registrations_expires_at" ON "pending_registrations" USING btree ("expires_at");