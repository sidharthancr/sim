ALTER TABLE "workspace" ADD COLUMN "organization_id" text REFERENCES "public"."organization"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "workspace_organization_id_idx" ON "workspace" USING btree ("organization_id");
