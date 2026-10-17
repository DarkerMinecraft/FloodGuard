-- CreateEnum
CREATE TYPE "LocationSource" AS ENUM ('photo', 'device');

-- CreateEnum
CREATE TYPE "Moderation" AS ENUM ('approved', 'rejected', 'pending');

-- CreateEnum
CREATE TYPE "AlertLevel" AS ENUM ('low', 'moderate', 'high', 'severe');

-- CreateEnum
CREATE TYPE "PlaceKind" AS ENUM ('last', 'saved');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('threat', 'report');

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "photo_key" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" REAL,
    "note" TEXT NOT NULL DEFAULT '',
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "location_source" "LocationSource" NOT NULL,
    "taken_at" TEXT,
    "moderation" "Moderation" NOT NULL,
    "moderation_reason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "min_level" "AlertLevel" NOT NULL DEFAULT 'moderate',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_places" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "kind" "PlaceKind" NOT NULL,
    "label" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "located_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_level" "AlertLevel",
    "notified_at" TIMESTAMPTZ(3),

    CONSTRAINT "alert_places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_sent" (
    "id" BIGSERIAL NOT NULL,
    "place_id" UUID NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "ref" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_sent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reports_photo_key_key" ON "reports"("photo_key");

-- CreateIndex
CREATE INDEX "reports_submitted_at_idx" ON "reports"("submitted_at" DESC);

-- CreateIndex
CREATE INDEX "reports_moderation_submitted_at_idx" ON "reports"("moderation", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "alert_places_subscription_id_kind_label_key" ON "alert_places"("subscription_id", "kind", "label");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_sent_place_id_kind_ref_key" ON "alerts_sent"("place_id", "kind", "ref");

-- AddForeignKey
ALTER TABLE "alert_places" ADD CONSTRAINT "alert_places_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "push_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts_sent" ADD CONSTRAINT "alerts_sent_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "alert_places"("id") ON DELETE CASCADE ON UPDATE CASCADE;
