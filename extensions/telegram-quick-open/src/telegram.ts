import fs from "fs";
import path from "path";
import { LocalStorage, environment, getPreferenceValues } from "@raycast/api";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram/tl";
import type { Dialog } from "telegram/tl/custom/dialog";
import type {
  CachePayload,
  PendingLogin,
  TelegramResultType,
  TelegramSearchItem,
} from "./types";

const SESSION_KEY = "telegram-session";
const PENDING_LOGIN_KEY = "telegram-pending-login";
const CACHE_KEY = "telegram-dialog-cache";

export const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

export function getConfiguredPhoneNumber(): string {
  return getPreferenceValues<Preferences>().phoneNumber?.trim() ?? "";
}

export async function getStoredSession(): Promise<string> {
  return (await LocalStorage.getItem<string>(SESSION_KEY)) ?? "";
}

export async function clearStoredSession(): Promise<void> {
  await Promise.all([
    LocalStorage.removeItem(SESSION_KEY),
    LocalStorage.removeItem(PENDING_LOGIN_KEY),
    LocalStorage.removeItem(CACHE_KEY),
  ]);
}

export async function getPendingLogin(): Promise<PendingLogin | undefined> {
  const raw = await LocalStorage.getItem<string>(PENDING_LOGIN_KEY);
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as PendingLogin;
  } catch {
    await LocalStorage.removeItem(PENDING_LOGIN_KEY);
    return undefined;
  }
}

export async function loadCachedDialogs(): Promise<CachePayload | undefined> {
  const raw = await LocalStorage.getItem<string>(CACHE_KEY);
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as CachePayload;
  } catch {
    await LocalStorage.removeItem(CACHE_KEY);
    return undefined;
  }
}

export async function sendLoginCode(
  phoneNumber: string,
): Promise<PendingLogin> {
  const normalizedPhone = phoneNumber.trim();
  const session = new StringSession("");
  const client = createClient(session);

  await client.connect();
  try {
    const { phoneCodeHash, isCodeViaApp } = await client.sendCode(
      getApiCredentials(),
      normalizedPhone,
    );
    const pendingLogin: PendingLogin = {
      phoneNumber: normalizedPhone,
      phoneCodeHash,
      isCodeViaApp,
      session: session.save(),
      createdAt: Date.now(),
    };

    await LocalStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify(pendingLogin));
    return pendingLogin;
  } finally {
    await client.disconnect();
  }
}

export async function completeLogin(
  phoneCode: string,
  password?: string,
): Promise<void> {
  const pendingLogin = await getPendingLogin();
  if (!pendingLogin) {
    throw new Error("No pending Telegram login. Send a new login code first.");
  }

  const session = new StringSession(pendingLogin.session);
  const client = createClient(session);

  await client.connect();
  try {
    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: pendingLogin.phoneNumber,
          phoneCodeHash: pendingLogin.phoneCodeHash,
          phoneCode: phoneCode.trim(),
        }),
      );
    } catch (error) {
      if (!isTelegramPasswordNeeded(error)) {
        throw error;
      }

      const trimmedPassword = password?.trim();
      if (!trimmedPassword) {
        throw new Error(
          "Telegram requires your 2FA password. Enter it and submit again.",
        );
      }

      await client.signInWithPassword(getApiCredentials(), {
        password: async () => trimmedPassword,
        onError: async (err) => {
          throw err;
        },
      });
    }

    await LocalStorage.setItem(SESSION_KEY, session.save());
    await LocalStorage.removeItem(PENDING_LOGIN_KEY);
    await refreshDialogs();
  } finally {
    await client.disconnect();
  }
}

export async function refreshDialogs(): Promise<TelegramSearchItem[]> {
  const sessionString = await getStoredSession();
  if (!sessionString) {
    return [];
  }

  const session = new StringSession(sessionString);
  const client = createClient(session);

  await client.connect();
  try {
    if (!(await client.checkAuthorization())) {
      await clearStoredSession();
      throw new Error("Telegram session expired. Please sign in again.");
    }

    const avatarDir = path.join(environment.supportPath, "avatars");
    await fs.promises.mkdir(avatarDir, { recursive: true });

    const dialogs = await client.getDialogs({ limit: 500 });

    const pairs: Array<[Dialog, TelegramSearchItem]> = [];
    for (const dialog of dialogs) {
      const item = dialogToSearchItem(dialog);
      if (item) pairs.push([dialog, item]);
    }

    const activeAvatarFiles = new Set(
      pairs.map(([, item]) => `${item.id}.jpg`),
    );
    const existingAvatarFiles = await fs.promises.readdir(avatarDir);
    await Promise.allSettled(
      existingAvatarFiles
        .filter(
          (fileName) =>
            fileName.endsWith(".jpg") && !activeAvatarFiles.has(fileName),
        )
        .map((fileName) => fs.promises.unlink(path.join(avatarDir, fileName))),
    );

    await Promise.allSettled(
      pairs.map(async ([dialog, item]) => {
        if (!dialog.entity) return;

        // Download avatar
        try {
          const buffer = await client.downloadProfilePhoto(dialog.entity, {
            isBig: false,
          });
          if (buffer && Buffer.isBuffer(buffer) && buffer.length > 0) {
            const avatarPath = path.join(avatarDir, `${item.id}.jpg`);
            await fs.promises.writeFile(avatarPath, buffer);
            item.avatarPath = avatarPath;
          }
        } catch {
          // No avatar
        }

        // For groups/channels without a username, fetch invite link so we can use
        // tg://join?invite=HASH — more reliable than tg://openmessage?chat_id=
        if (
          !item.username &&
          (item.type === "group" || item.type === "channel")
        ) {
          const link = await getEntityInviteLink(client, dialog);
          if (link) {
            const hash = link.replace(/^https:\/\/t\.me\/(\+|joinchat\/)/, "");
            item.deepLink = `tg://join?invite=${hash}`;
            item.fallbackUrl = link;
          }
        }
      }),
    );

    const items = pairs.map(([, item]) => item);
    const payload: CachePayload = { items, updatedAt: Date.now() };
    await Promise.all([
      LocalStorage.setItem(SESSION_KEY, session.save()),
      LocalStorage.setItem(CACHE_KEY, JSON.stringify(payload)),
    ]);
    return items;
  } finally {
    await client.disconnect();
  }
}

function createClient(session: StringSession): TelegramClient {
  const { apiId, apiHash } = getPreferences();

  return new TelegramClient(session, Number(apiId), apiHash, {
    connectionRetries: 3,
  });
}

function getPreferences(): Preferences {
  const preferences = getPreferenceValues<Preferences>();
  const apiId = Number(String(preferences.apiId ?? "").trim());

  if (!preferences.apiId || !Number.isFinite(apiId) || apiId <= 0) {
    throw new Error(
      "Telegram API ID is not configured. Press ⌘, to open Extension Preferences and fill in your API ID from my.telegram.org.",
    );
  }

  return { ...preferences, apiId: String(apiId) };
}

function getApiCredentials() {
  const { apiId, apiHash } = getPreferences();
  return { apiId: Number(apiId), apiHash };
}

type EntityKind = "user" | "chat" | "channel";

function getEntityKind(entity: object): EntityKind {
  if (entity instanceof Api.User) return "user";
  if (entity instanceof Api.Chat || entity instanceof Api.ChatForbidden)
    return "chat";
  return "channel";
}

function dialogToSearchItem(dialog: Dialog): TelegramSearchItem | undefined {
  const entity = dialog.entity;
  if (!entity || !("id" in entity)) {
    return undefined;
  }

  const entityKind = getEntityKind(entity);
  const type = getDialogType(dialog, entity);
  const username = getStringProperty(entity, "username");
  const phone = getStringProperty(entity, "phone");
  const title = getDialogTitle(dialog, entity);
  const id = (entity as { id: { toString(): string } }).id.toString();
  const participantsCount = getNumberProperty(entity, "participantsCount");
  const deepLink = buildDeepLink(entityKind, id, { username, phone });
  const fallbackUrl = username ? `https://t.me/${username}` : undefined;
  const keywords = [title, username, phone, type].filter(
    (value): value is string => Boolean(value),
  );

  return {
    id: `${type}-${id}`,
    type,
    title,
    username,
    phone,
    participantsCount,
    deepLink,
    fallbackUrl,
    keywords,
    updatedAt: Date.now(),
  };
}

function getDialogType(dialog: Dialog, entity: object): TelegramResultType {
  if (dialog.isUser || "firstName" in entity || "phone" in entity) {
    return "user";
  }

  if (
    "broadcast" in entity &&
    Boolean((entity as { broadcast?: boolean }).broadcast)
  ) {
    return "channel";
  }

  return "group";
}

function getDialogTitle(dialog: Dialog, entity: object): string {
  const firstName = getStringProperty(entity, "firstName");
  const lastName = getStringProperty(entity, "lastName");
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return (
    fullName ||
    getStringProperty(entity, "title") ||
    dialog.title ||
    dialog.name ||
    "Untitled Telegram Chat"
  );
}

function buildDeepLink(
  entityKind: EntityKind,
  id: string,
  opts: { username?: string; phone?: string },
): string {
  const { username, phone } = opts;

  if (username) {
    return `tg://resolve?domain=${encodeURIComponent(username)}`;
  }

  if (entityKind === "user") {
    // Phone number stored without leading +, e.g. "84901234567"
    if (phone) {
      return `tg://resolve?phone=${encodeURIComponent(`+${phone}`)}`;
    }
    return `tg://openmessage?user_id=${encodeURIComponent(id)}`;
  }

  // Regular group (Api.Chat): invite link will override this in refreshDialogs
  if (entityKind === "chat") {
    return `tg://openmessage?chat_id=-${encodeURIComponent(id)}`;
  }

  // Supergroup/channel: pin message id to 1 so cached links don't jump to stale history.
  return `https://t.me/c/${id}/1`;
}

function getStringProperty(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNumberProperty(source: object, key: string): number | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

async function getEntityInviteLink(
  client: TelegramClient,
  dialog: Dialog,
): Promise<string | undefined> {
  const entity = dialog.entity;
  if (!entity) return undefined;

  try {
    let exportedInvite: unknown;

    if (entity instanceof Api.Chat) {
      const result = await client.invoke(
        new Api.messages.GetFullChat({ chatId: entity.id }),
      );
      exportedInvite = (result.fullChat as { exportedInvite?: unknown })
        .exportedInvite;
    } else if (entity instanceof Api.Channel) {
      const result = await client.invoke(
        new Api.channels.GetFullChannel({
          channel: new Api.InputChannel({
            channelId: entity.id,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            accessHash: (entity.accessHash ?? 0) as any,
          }),
        }),
      );
      exportedInvite = (result.fullChat as { exportedInvite?: unknown })
        .exportedInvite;
    }

    if (exportedInvite instanceof Api.ChatInviteExported) {
      return exportedInvite.link;
    }
  } catch (err) {
    console.error("getEntityInviteLink failed:", err);
  }

  return undefined;
}

function isTelegramPasswordNeeded(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errorMessage" in error &&
    (error as { errorMessage?: string }).errorMessage ===
      "SESSION_PASSWORD_NEEDED"
  );
}
