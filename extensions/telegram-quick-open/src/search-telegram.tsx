import {
  Action,
  ActionPanel,
  Color,
  Form,
  Icon,
  Image,
  List,
  LocalStorage,
  Toast,
  open,
  showToast,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import {
  CACHE_MAX_AGE_MS,
  clearStoredSession,
  completeLogin,
  getConfiguredPhoneNumber,
  getPendingLogin,
  getStoredSession,
  loadCachedDialogs,
  refreshDialogs,
  sendLoginCode,
} from "./telegram";
import type { PendingLogin, TelegramSearchItem } from "./types";

const HIDDEN_KEY = "telegram-hidden-items";

async function loadHiddenIds(): Promise<Set<string>> {
  const raw = await LocalStorage.getItem<string>(HIDDEN_KEY);
  if (!raw) return new Set();
  try {
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

async function saveHiddenIds(ids: Set<string>): Promise<void> {
  await LocalStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]));
}

type LoginStep = "send-code" | "complete-login";

export default function Command() {
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [pendingLogin, setPendingLogin] = useState<PendingLogin | undefined>();
  const [loginStep, setLoginStep] = useState<LoginStep>("send-code");

  useEffect(() => {
    async function loadAuthState() {
      const [session, pending] = await Promise.all([
        getStoredSession(),
        getPendingLogin(),
      ]);
      setHasSession(Boolean(session));
      setPendingLogin(pending);
      setLoginStep(pending ? "complete-login" : "send-code");
      setIsCheckingAuth(false);
    }

    loadAuthState();
  }, []);

  if (isCheckingAuth) {
    return <List isLoading />;
  }

  if (!hasSession) {
    if (loginStep === "complete-login" && pendingLogin) {
      return (
        <CompleteLoginForm
          pendingLogin={pendingLogin}
          onBack={() => setLoginStep("send-code")}
          onComplete={() => setHasSession(true)}
        />
      );
    }

    return (
      <SendCodeForm
        defaultPhoneNumber={getConfiguredPhoneNumber()}
        onCodeSent={(nextPendingLogin) => {
          setPendingLogin(nextPendingLogin);
          setLoginStep("complete-login");
        }}
      />
    );
  }

  return <TelegramSearchList onSignOut={() => setHasSession(false)} />;
}

function SendCodeForm(props: {
  defaultPhoneNumber: string;
  onCodeSent: (pendingLogin: PendingLogin) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(values: { phoneNumber: string }) {
    setIsLoading(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Sending Telegram login code",
    });

    try {
      const pendingLogin = await sendLoginCode(values.phoneNumber);
      toast.style = Toast.Style.Success;
      toast.title = pendingLogin.isCodeViaApp
        ? "Code sent in Telegram"
        : "Code sent by SMS";
      props.onCodeSent(pendingLogin);
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could not send Telegram code";
      toast.message = getErrorMessage(error);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Send Login Code"
            icon={Icon.Envelope}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.Description text="Sign in with your Telegram user account. The session is stored locally in Raycast storage." />
      <Form.TextField
        id="phoneNumber"
        title="Phone Number"
        defaultValue={props.defaultPhoneNumber}
        placeholder="+84901234567"
      />
    </Form>
  );
}

function CompleteLoginForm(props: {
  pendingLogin: PendingLogin;
  onBack: () => void;
  onComplete: () => void;
}) {
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(values: {
    phoneCode: string;
    password?: string;
  }) {
    setIsLoading(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Signing in to Telegram",
    });

    try {
      await completeLogin(values.phoneCode, values.password);
      toast.style = Toast.Style.Success;
      toast.title = "Telegram signed in";
      props.onComplete();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could not sign in";
      toast.message = getErrorMessage(error);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Complete Login"
            icon={Icon.CheckCircle}
            onSubmit={handleSubmit}
          />
          <Action
            title="Send a New Code"
            icon={Icon.ArrowLeft}
            onAction={props.onBack}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        text={`Enter the code sent to ${props.pendingLogin.phoneNumber}. If Telegram asks for 2FA, enter your password too.`}
      />
      <Form.TextField id="phoneCode" title="Login Code" placeholder="12345" />
      <Form.PasswordField
        id="password"
        title="2FA Password"
        placeholder="Only required if enabled"
      />
    </Form>
  );
}

function TelegramSearchList(props: { onSignOut: () => void }) {
  const [items, setItems] = useState<TelegramSearchItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | undefined>();
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    async function loadDialogs() {
      const [cached, hidden] = await Promise.all([
        loadCachedDialogs(),
        loadHiddenIds(),
      ]);
      setHiddenIds(hidden);
      if (cached) {
        setItems(cached.items);
        setLastUpdatedAt(cached.updatedAt);
        setIsLoading(false);
      }
      if (!cached || Date.now() - cached.updatedAt > CACHE_MAX_AGE_MS) {
        await handleRefresh({ quiet: Boolean(cached) });
      }
      setIsLoading(false);
    }
    loadDialogs();
  }, []);

  async function handleRefresh(options?: { quiet?: boolean }) {
    const toast = options?.quiet
      ? undefined
      : await showToast({
          style: Toast.Style.Animated,
          title: "Refreshing Telegram dialogs",
        });
    try {
      const nextItems = await refreshDialogs();
      setItems(nextItems);
      setLastUpdatedAt(Date.now());
      if (toast) {
        toast.style = Toast.Style.Success;
        toast.title = "Telegram dialogs refreshed";
        toast.message = `${nextItems.length} chats loaded`;
      }
    } catch (error) {
      if (toast) {
        toast.style = Toast.Style.Failure;
        toast.title = "Could not refresh Telegram";
        toast.message = getErrorMessage(error);
      } else {
        await showToast({
          style: Toast.Style.Failure,
          title: "Could not refresh Telegram",
          message: getErrorMessage(error),
        });
      }
    }
  }

  async function handleToggleHide(item: TelegramSearchItem) {
    const next = new Set(hiddenIds);
    if (next.has(item.id)) {
      next.delete(item.id);
    } else {
      next.add(item.id);
    }
    setHiddenIds(next);
    await saveHiddenIds(next);
  }

  async function handleSignOut() {
    await clearStoredSession();
    setItems([]);
    props.onSignOut();
  }

  const navigationTitle = useMemo(() => {
    if (!lastUpdatedAt) return "Search Telegram";
    return `Search Telegram · ${new Date(lastUpdatedAt).toLocaleTimeString()}`;
  }, [lastUpdatedAt]);

  const visibleItems = useMemo(
    () => (showHidden ? items : items.filter((i) => !hiddenIds.has(i.id))),
    [items, hiddenIds, showHidden],
  );

  const contacts = useMemo(
    () => visibleItems.filter((i) => i.type === "user"),
    [visibleItems],
  );
  const groups = useMemo(
    () =>
      visibleItems.filter((i) => i.type === "group" || i.type === "channel"),
    [visibleItems],
  );

  const hasHidden = hiddenIds.size > 0;

  function renderItem(item: TelegramSearchItem) {
    const isHidden = hiddenIds.has(item.id);
    return (
      <List.Item
        key={item.id}
        title={item.title}
        subtitle={getSubtitle(item)}
        keywords={item.keywords}
        icon={getIcon(item)}
        accessories={getAccessories(item)}
        actions={
          <ActionPanel>
            <Action
              title="Open in Telegram"
              icon={Icon.Message}
              onAction={() => openTelegramItem(item)}
            />
            <Action.CopyToClipboard
              title="Copy Telegram Link"
              content={item.fallbackUrl ?? item.deepLink}
            />
            <Action
              title={isHidden ? "Unhide from Search" : "Hide from Search"}
              icon={isHidden ? Icon.Eye : Icon.EyeDisabled}
              shortcut={{ modifiers: ["cmd"], key: "h" }}
              onAction={() => handleToggleHide(item)}
            />
            <Action
              title="Refresh Telegram Dialogs"
              icon={Icon.ArrowClockwise}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={() => handleRefresh()}
            />
            <Action
              title="Clear Telegram Session"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              onAction={handleSignOut}
            />
          </ActionPanel>
        }
      />
    );
  }

  return (
    <List
      isLoading={isLoading}
      navigationTitle={navigationTitle}
      searchBarPlaceholder="Search contacts, groups, channels..."
      filtering={{ keepSectionOrder: true }}
      searchBarAccessory={
        hasHidden ? (
          <List.Dropdown
            tooltip="Filter"
            onChange={(v) => setShowHidden(v === "hidden")}
          >
            <List.Dropdown.Item title="Visible" value="visible" />
            <List.Dropdown.Item
              title={`Hidden (${hiddenIds.size})`}
              value="hidden"
            />
          </List.Dropdown>
        ) : undefined
      }
    >
      <List.EmptyView
        icon={Icon.Message}
        title="No Telegram chats loaded"
        description="Refresh dialogs after signing in."
        actions={
          <ActionPanel>
            <Action
              title="Refresh Telegram Dialogs"
              icon={Icon.ArrowClockwise}
              onAction={() => handleRefresh()}
            />
          </ActionPanel>
        }
      />
      <List.Section title="Contacts">{contacts.map(renderItem)}</List.Section>
      <List.Section title="Groups & Channels">
        {groups.map(renderItem)}
      </List.Section>
    </List>
  );
}

async function openTelegramItem(item: TelegramSearchItem) {
  try {
    // t.me/c/ links for private supergroups must be opened directly inside
    // Telegram Desktop — the system handler routes them to the browser otherwise.
    if (item.deepLink.startsWith("https://t.me/c/")) {
      // Try App Store build first, then telegram.org desktop build.
      try {
        await open(item.deepLink, "ru.keepcoder.Telegram");
      } catch {
        await open(item.deepLink, "org.telegram.desktop");
      }
    } else {
      await open(item.deepLink);
    }
  } catch {
    if (item.fallbackUrl) {
      await open(item.fallbackUrl);
    } else {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not open Telegram chat",
      });
    }
  }
}

function getSubtitle(item: TelegramSearchItem): string {
  const parts = [];
  if (item.username) {
    parts.push(`@${item.username}`);
  }
  if (item.phone) {
    parts.push(`+${item.phone}`);
  }
  if (item.participantsCount) {
    parts.push(`${item.participantsCount} members`);
  }

  return parts.join("  ");
}

function getIcon(item: TelegramSearchItem) {
  if (item.avatarPath) {
    return { source: item.avatarPath, mask: Image.Mask.Circle };
  }
  switch (item.type) {
    case "user":
      return { source: Icon.Person, tintColor: Color.Blue };
    case "channel":
      return { source: Icon.Megaphone, tintColor: Color.Purple };
    case "group":
      return { source: Icon.TwoPeople, tintColor: Color.Green };
  }
}

function getAccessories(item: TelegramSearchItem): List.Item.Accessory[] {
  const icon =
    item.type === "user"
      ? Icon.Person
      : item.type === "channel"
        ? Icon.Megaphone
        : Icon.TwoPeople;
  return [
    {
      icon: { source: icon, tintColor: Color.SecondaryText },
      tooltip: item.type,
    },
  ];
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
