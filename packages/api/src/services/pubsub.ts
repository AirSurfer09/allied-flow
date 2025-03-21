import { z } from "zod";
import Redis from "ioredis";
import EventEmitter from "events";
import type { TransactionType, db } from "@repo/db/client";
import { devices, notifications } from "@repo/db/schema";
import { nanoid } from "nanoid";
import { and, eq, inArray, lt } from "@repo/db";
import { sendPushNotifications } from "./expo.js";
import { env } from "@repo/server-config";
import { sendWhatsappNotifications } from "./whatsapp.js";
import { sendEmailNotifications } from "./resend.js";

const redis = new Redis(env.REDIS_URL);

export const getNotificationChanelForUser = (userId: string) => {
  return `notification:user:${userId}`;
};

const baseNotificationSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  message: z.string(),
  read: z.boolean().optional(),
  userId: z.string(),
});

export const notificationSchema = z.discriminatedUnion("type", [
  baseNotificationSchema.extend({
    type: z.literal("ORDER_PLACED"),
    orderId: z.string(),
    orderType: z.enum(["REGULAR", "SAMPLE"]),
  }),
  baseNotificationSchema.extend({
    type: z.literal("ORDER_DISPATCHED"),
    orderId: z.string(),
    orderType: z.enum(["REGULAR", "SAMPLE"]),
  }),
  baseNotificationSchema.extend({
    type: z.literal("ORDER_SHIPPED"),
    orderId: z.string(),
    orderType: z.enum(["REGULAR", "SAMPLE"]),
  }),
  baseNotificationSchema.extend({
    type: z.literal("INQUIRY_RECEIVED"),
    inquiryId: z.string(),
  }),
  baseNotificationSchema.extend({
    type: z.literal("NEW_QUOTE_RECEIVED"),
    quoteId: z.string(),
    inquiryId: z.string(),
  }),
  baseNotificationSchema.extend({
    type: z.literal("QUOTE_ACCEPTED"),
    quoteId: z.string(),
    inquiryId: z.string(),
  }),
  baseNotificationSchema.extend({
    type: z.literal("QUOTE_REJECTED"),
    quoteId: z.string(),
    inquiryId: z.string(),
  }),
]);

const getNotificationTitle = (n: Notification) => {
  if (n.type === "ORDER_PLACED") {
    const prefix = n.orderType === "REGULAR" ? "Order" : "Sample";
    return `${prefix} placed`;
  }
  if (n.type === "ORDER_DISPATCHED") {
    const prefix = n.orderType === "REGULAR" ? "Order" : "Sample";
    return `${prefix} dispatched`;
  }
  if (n.type === "ORDER_SHIPPED") {
    const prefix = n.orderType === "REGULAR" ? "Order" : "Sample";
    return `${prefix} shipped`;
  }
  if (n.type === "INQUIRY_RECEIVED") {
    return "Inquiry Received";
  }
  if (n.type === "NEW_QUOTE_RECEIVED") {
    return "New Quote Received";
  }
  if (n.type === "QUOTE_ACCEPTED") {
    return "Quote Accepted";
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (n.type === "QUOTE_REJECTED") {
    return "Quote Rejected";
  }
  return "New Notification From Spot!";
};

export type Notification = z.infer<typeof notificationSchema>;

// use ioredis to publish notifications to the chanel for a given userId
export const createNotification = async (
  tx: typeof db,
  notification: Notification,
) => {
  const n = await tx
    .insert(notifications)
    .values({
      ...notification,
      id: nanoid(),
      read: false,
    })
    .returning();
  if (n.length === 0) {
    return;
  }
  return n[0] as Notification;
};

export const sendNotifications = async (
  tx: typeof db,
  notifications: Notification[],
) => {
  const pushTokensForUsers = await tx.query.devices.findMany({
    where: (devices) =>
      inArray(devices.userId, [...new Set(notifications.map((n) => n.userId))]),
    with: {
      user: true,
    },
  });

  const pushTokensByUserId = pushTokensForUsers.reduce(
    (acc, device) => {
      if (!acc[device.userId]) {
        acc[device.userId] = [];
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      acc[device.userId]!.push(device.expoPushToken);
      return acc;
    },
    {} as Record<string, string[]>,
  );

  const phoneNumberByUserId = pushTokensForUsers.reduce(
    (acc, device) => {
      if (!acc[device.userId]) {
        acc[device.userId] = device.user.phone;
      }
      return acc;
    },
    {} as Record<string, string>,
  );

  const emailByUserId = pushTokensForUsers.reduce(
    (acc, device) => {
      if (!acc[device.userId]) {
        acc[device.userId] = device.user.email;
      }
      return acc;
    },
    {} as Record<string, string>,
  );

  const tokensToCleanup: string[][] = [];

  const inAppPromises = notifications
    .map((notification) => {
      const notificationPromises: Promise<void>[] = [
        sendInAppNotification(notification),
      ];

      // push notifications
      const pushTokens = pushTokensByUserId[notification.userId];
      if (pushTokens) {
        notificationPromises.push(
          (async () => {
            const failedTokens = await sendPushNotifications(
              pushTokens,
              getNotificationTitle(notification),
              notification.message,
            );
            tokensToCleanup.push(failedTokens);
          })(),
        );
      }

      const phoneNumber = phoneNumberByUserId[notification.userId];
      if (phoneNumber) {
        notificationPromises.push(
          sendWhatsappNotifications(
            [phoneNumber],
            notification,
          ),
        );
      }

      const email = emailByUserId[notification.userId];
      if (email) {
        notificationPromises.push(
          sendEmailNotifications([email], notification),
        );
      }

      return notificationPromises;
    })
    .flat();

  await Promise.all(inAppPromises);
  await tx
    .delete(devices)
    .where(inArray(devices.expoPushToken, tokensToCleanup.flat()))
    .execute();
};

const sendInAppNotification = async (notification: Notification) => {
  await redis.publish(
    getNotificationChanelForUser(notification.userId),
    JSON.stringify(notification),
  );
};

export const subscribeToNotifications = async (userId: string) => {
  const channel = getNotificationChanelForUser(userId);
  const sub = new Redis();
  await sub.subscribe(channel);

  // Create an EventEmitter to handle notifications
  const emitter = new EventEmitter();

  sub.on("message", (_channel, message) => {
    const notification = notificationSchema.parse(JSON.parse(message));
    emitter.emit("notification", notification);
  });

  // Return a function to unsubscribe and quit
  return {
    emitter,
    cleanup: () => Promise.all([sub.unsubscribe(channel), sub.quit()]),
  };
};

export const getAllNotifications = async (
  tx: TransactionType,
  userId: string,
  { limit, cursor }: { limit: number; cursor?: string },
) => {
  const notifications = await tx.query.notifications.findMany({
    where: (notifications) =>
      and(
        eq(notifications.userId, userId),
        cursor ? lt(notifications.createdAt, cursor) : undefined,
      ),
    orderBy: (notifications, { desc }) => desc(notifications.createdAt),
    limit,
  });
  console.log("notifications", notifications);

  return notifications
    .map((notification) => {
      const { success, data } = notificationSchema.safeParse(notification);
      if (!success) {
        console.error("Failed to parse notification", notification);
        return null;
      }
      return data;
    })
    .filter(Boolean) as Notification[];
};

export const markNotificationAsRead = async (
  tx: TransactionType,
  userId: string,
  notificationId: string,
) => {
  await tx
    .update(notifications)
    .set({ read: true })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.id, notificationId),
      ),
    );
};
