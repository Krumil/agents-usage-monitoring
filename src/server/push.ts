import webpush from "web-push";

import type { UsageDatabase } from "./db.js";
import type { SessionRefreshEvent, SessionRefreshNotifier } from "./limits.js";
import { formatSessionRefreshMessage } from "./telegram.js";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  url?: string;
}

export interface PushSender {
  sendToAll(payload: PushNotificationPayload): Promise<void>;
  createSessionRefreshNotifier(): SessionRefreshNotifier;
}

export type PushSendErrorHandler = (error: unknown, endpoint: string) => void;

export function createPushSender(
  database: UsageDatabase,
  vapid: VapidConfig,
  onError?: PushSendErrorHandler
): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  async function sendToAll(payload: PushNotificationPayload): Promise<void> {
    const subscriptions = database.listPushSubscriptions();
    const body = JSON.stringify(payload);

    await Promise.all(
      subscriptions.map(async ({ endpoint, subscription }) => {
        try {
          await webpush.sendNotification(subscription, body);
        } catch (error) {
          if (isExpiredSubscriptionError(error)) {
            database.deletePushSubscription(endpoint);
            return;
          }

          onError?.(error, endpoint);
        }
      })
    );
  }

  return {
    sendToAll,
    createSessionRefreshNotifier(): SessionRefreshNotifier {
      return {
        async sendSessionRefreshAlert(event: SessionRefreshEvent): Promise<void> {
          await sendToAll({
            title: "Claude Code — session refreshed",
            body: formatSessionRefreshMessage(event),
            url: "/"
          });
        }
      };
    }
  };
}

function isExpiredSubscriptionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return statusCode === 404 || statusCode === 410;
}
