-- Gemini photo findings (depth, extent, hazards) used for alert decisions and flood areas.
ALTER TABLE "reports" ADD COLUMN "photo_analysis" JSONB;
