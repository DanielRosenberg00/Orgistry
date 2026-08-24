CREATE INDEX "ix_email_verification_tokens_expires_at" ON "email_verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ix_password_reset_tokens_expires_at" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ix_refresh_tokens_expires_at" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ix_security_events_session_id" ON "security_events" USING btree ("session_id");