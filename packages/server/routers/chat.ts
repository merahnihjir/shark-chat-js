import { TRPCError } from "@trpc/server";
import { channels } from "../ably";
import { z } from "zod";
import { protectedProcedure, router } from "./../trpc";
import {
    AttachmentType,
    UploadAttachment,
    contentSchema,
    uploadAttachmentSchema,
} from "shared/schema/chat";
import { getLastRead, setLastRead } from "../redis/last-read";
import db from "db/client";
import {
    Attachment,
    attachments,
    directMessageInfos,
    groups,
    messageChannels,
    messages,
    users,
} from "db/schema";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { requireOne } from "db/utils";
import { createId } from "@paralleldrive/cuid2";
import { generateText } from "../eden";
import { onReceiveMessage } from "../inworld";
import { alias } from "drizzle-orm/mysql-core";
import { checkChannelPermissions } from "../utils/permissions";
import { pick } from "shared/common";

const userProfileKeys = ["id", "name", "image"] as const;

export const chatRouter = router({
    send: protectedProcedure
        .input(
            z
                .object({
                    channelId: z.string(),
                    content: contentSchema,
                    attachment: uploadAttachmentSchema.optional(),
                    reply: z.number().optional(),
                    nonce: z.number().optional(),
                })
                .refine(
                    ({ content, attachment }) =>
                        content.length !== 0 || attachment != null,
                    "Message is empty"
                )
        )
        .mutation(async ({ input, ctx }) => {
            const { type, data } = await checkChannelPermissions(
                input.channelId,
                ctx.session
            );

            const message = await db.transaction(async () => {
                const attachment = await insertAttachment(input.attachment);

                const message_id = await db
                    .insert(messages)
                    .values({
                        author_id: ctx.session.user.id,
                        content: input.content,
                        channel_id: input.channelId,
                        attachment_id: attachment?.id ?? null,
                        reply_id: input.reply,
                    })
                    .then((res) => Number(res.insertId));

                const reply_message = alias(messages, "reply_message");
                const reply_user = alias(users, "reply_user");

                const message = await db
                    .select({
                        ...(messages as typeof messages._.columns),
                        reply_message: pick(reply_message, "content"),
                        reply_user: pick(reply_user, ...userProfileKeys),
                        author: pick(users, ...userProfileKeys),
                    })
                    .from(messages)
                    .where(eq(messages.id, message_id))
                    .innerJoin(users, eq(users.id, messages.author_id))
                    .leftJoin(
                        reply_message,
                        eq(reply_message.id, messages.reply_id)
                    )
                    .leftJoin(
                        reply_user,
                        eq(reply_message.author_id, reply_user.id)
                    )
                    .then((res) => requireOne(res));

                await db
                    .update(messageChannels)
                    .set({
                        last_message_id: message.id,
                    })
                    .where(eq(messageChannels.id, message.channel_id));

                let is_new_dm = false;

                if (type === "dm") {
                    const result = await db
                        .update(directMessageInfos)
                        .set({
                            open: true,
                        })
                        .where(
                            and(
                                eq(
                                    directMessageInfos.channel_id,
                                    input.channelId
                                ),
                                eq(directMessageInfos.open, false)
                            )
                        );
                    is_new_dm = result.rowsAffected !== 0;
                }

                return {
                    ...message,
                    attachment,
                    is_new_dm,
                    nonce: input.nonce,
                };
            });

            if (type === "dm" && message.is_new_dm) {
                await channels.private.open_dm.publish([data.to_user_id], {
                    id: data.channel_id,
                    user: message.author,
                    unread_messages: 1,
                });
            }

            await Promise.all([
                channels.chat.message_sent.publish([input.channelId], message),
                setLastRead(
                    input.channelId,
                    ctx.session.user.id,
                    message.timestamp
                ),
            ]);

            if (input.content.startsWith("@Shark")) {
                await onReceiveMessage({
                    content: input.content,
                    channel_id: input.channelId,
                    user_name: message.author.name,
                });
            }

            return message;
        }),
    messages: protectedProcedure
        .input(
            z.object({
                channelId: z.string(),
                count: z.number().min(0).max(50).default(50),
                cursorType: z.enum(["after", "before"]).default("before"),
                cursor: z.string().datetime().optional(),
            })
        )
        .query(async ({ input, ctx }) => {
            await checkChannelPermissions(input.channelId, ctx.session);
            const count = Math.min(input.count, 50);

            const reply_message = alias(messages, "reply_message");
            const reply_user = alias(users, "reply_user");

            return await db
                .select({
                    ...(messages as typeof messages._.columns),
                    author: pick(users, ...userProfileKeys),
                    attachment: attachments,
                    reply_message: pick(reply_message, "content"),
                    reply_user: pick(reply_user, ...userProfileKeys),
                })
                .from(messages)
                .where(
                    and(
                        eq(messages.channel_id, input.channelId),
                        input.cursor != null && input.cursorType === "after"
                            ? gt(messages.timestamp, new Date(input.cursor))
                            : undefined,
                        input.cursor != null && input.cursorType === "before"
                            ? lt(messages.timestamp, new Date(input.cursor))
                            : undefined
                    )
                )
                .leftJoin(users, eq(users.id, messages.author_id))
                .leftJoin(
                    attachments,
                    eq(attachments.id, messages.attachment_id)
                )
                .leftJoin(
                    reply_message,
                    eq(messages.reply_id, reply_message.id)
                )
                .leftJoin(
                    reply_user,
                    eq(reply_message.author_id, reply_user.id)
                )
                .orderBy(desc(messages.timestamp))
                .limit(count);
        }),
    update: protectedProcedure
        .input(
            z.object({
                messageId: z.number(),
                channelId: z.string(),
                content: contentSchema,
            })
        )
        .mutation(async ({ ctx, input }) => {
            const rows = await db
                .update(messages)
                .set({
                    content: input.content,
                })
                .where(
                    and(
                        eq(messages.id, input.messageId),
                        eq(messages.author_id, ctx.session.user.id),
                        eq(messages.channel_id, input.channelId)
                    )
                );

            if (rows.rowsAffected === 0)
                throw new TRPCError({
                    code: "BAD_REQUEST",
                    message: "No permission or message doesn't exist",
                });

            await channels.chat.message_updated.publish([input.channelId], {
                id: input.messageId,
                content: input.content,
                channel_id: input.channelId,
            });
        }),
    delete: protectedProcedure
        .input(
            z.object({
                messageId: z.number(),
            })
        )
        .mutation(async ({ ctx, input }) => {
            const { channel_id } = await checkDeleteMessage(
                input.messageId,
                ctx.session.user.id
            );

            await db.delete(messages).where(eq(messages.id, input.messageId));
            await channels.chat.message_deleted.publish([channel_id], {
                id: input.messageId,
                channel_id,
            });
        }),
    read: protectedProcedure
        .input(z.object({ channelId: z.string() }))
        .mutation(async ({ ctx, input }) => {
            await setLastRead(
                input.channelId,
                ctx.session.user.id,
                new Date(Date.now())
            );
        }),
    checkout: protectedProcedure
        .input(
            z.object({
                channelId: z.string(),
            })
        )
        .query(async ({ ctx, input }) => {
            const old = await getLastRead(input.channelId, ctx.session.user.id);

            await setLastRead(
                input.channelId,
                ctx.session.user.id,
                new Date(Date.now())
            );

            return { last_read: old };
        }),
    type: protectedProcedure
        .input(
            z.object({
                channelId: z.string(),
            })
        )
        .mutation(async ({ ctx, input }) => {
            const user = await db
                .select(pick(users, ...userProfileKeys))
                .from(users)
                .where(eq(users.id, ctx.session.user.id))
                .then((res) => res[0]);

            if (user == null)
                throw new TRPCError({
                    code: "BAD_REQUEST",
                    message: "User not found",
                });

            await channels.chat.typing.publish([input.channelId], {
                user,
            });
        }),
    generateText: protectedProcedure
        .input(z.object({ text: z.string().trim().min(0) }))
        .mutation(async ({ input }) => {
            return {
                text: await generateText(input.text),
            };
        }),
});

async function checkDeleteMessage(messageId: number, user: string) {
    const message = await db
        .select({
            author_id: messages.author_id,
            channel_id: messages.channel_id,
        })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
        .then((res) => res[0]);

    if (message == null)
        throw new TRPCError({
            code: "NOT_FOUND",
            message: "Message not found",
        });

    if (message.author_id === user) {
        return { channel_id: message.channel_id };
    }

    const group_rows = await db
        .select({ owner: groups.owner_id })
        .from(groups)
        //.where(eq(groups.id, message.channel_id))
        .limit(1);

    if (group_rows.length !== 0 && group_rows[0].owner === user) {
        return { channel_id: message.channel_id };
    }

    throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Missing required permission",
    });
}

export function insertAttachment(
    attachment: UploadAttachment
): Promise<AttachmentType>;

export function insertAttachment(
    attachment: UploadAttachment | null | undefined
): Promise<AttachmentType | null>;

export async function insertAttachment(
    attachment: UploadAttachment | null | undefined
): Promise<AttachmentType | null> {
    if (attachment == null) return null;

    const values: Attachment = {
        ...attachment,
        id: createId(),
        width: attachment.width ?? null,
        height: attachment.height ?? null,
    };

    await db.insert(attachments).values({ ...values });

    return values;
}
