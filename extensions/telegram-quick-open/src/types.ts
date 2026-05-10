export type TelegramResultType = "user" | "group" | "channel";

export type TelegramSearchItem = {
  id: string;
  type: TelegramResultType;
  title: string;
  username?: string;
  phone?: string;
  participantsCount?: number;
  deepLink: string;
  fallbackUrl?: string;
  keywords: string[];
  updatedAt: number;
  avatarPath?: string;
};

export type PendingLogin = {
  phoneNumber: string;
  phoneCodeHash: string;
  isCodeViaApp: boolean;
  session: string;
  createdAt: number;
};

export type CachePayload = {
  items: TelegramSearchItem[];
  updatedAt: number;
};
