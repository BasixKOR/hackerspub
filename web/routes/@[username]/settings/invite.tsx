import { page } from "@fresh/core";
import { getAvatarUrl } from "@hackerspub/models/avatar";
import {
  type Account,
  accountTable,
  type Actor,
} from "@hackerspub/models/schema";
import { createSignupToken } from "@hackerspub/models/signup";
import { eq, sql } from "drizzle-orm";
import { Button } from "../../../components/Button.tsx";
import { Input } from "../../../components/Input.tsx";
import { Label } from "../../../components/Label.tsx";
import { Msg } from "../../../components/Msg.tsx";
import { PageTitle } from "../../../components/PageTitle.tsx";
import { SettingsNav } from "../../../components/SettingsNav.tsx";
import { TextArea } from "../../../components/TextArea.tsx";
import { db } from "../../../db.ts";
import { sendEmail } from "../../../email.ts";
import getFixedT, {
  isLanguage,
  type Language,
  SUPPORTED_LANGUAGES,
} from "../../../i18n.ts";
import { kv } from "../../../kv.ts";
import { define } from "../../../utils.ts";

export const EXPIRATION = Temporal.Duration.from({ hours: 48 });

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.account == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: { username: ctx.params.username },
      with: {
        inviter: {
          with: { actor: true },
        },
        invitees: {
          with: { actor: true },
          orderBy: { created: "desc" },
        },
      },
    });
    if (ctx.state.account.id !== account?.id) return ctx.next();
    return page<InvitePageProps>({
      account,
    });
  },

  async POST(ctx) {
    if (ctx.state.account == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: { username: ctx.params.username },
      with: {
        inviter: {
          with: { actor: true },
        },
        invitees: {
          with: { actor: true },
          orderBy: { created: "desc" },
        },
      },
    });
    if (ctx.state.account.id !== account?.id) return ctx.next();
    if (account.leftInvitations < 1) {
      return page<InvitePageProps>({
        success: false,
        account,
        error: "noLeftInvitations",
      });
    }
    const form = await ctx.req.formData();
    const email = form.get("email")?.toString()?.trim();
    let language = form.get("language")?.toString()?.trim();
    if (language == null || !isLanguage(language)) {
      language = ctx.state.language;
    }
    const message = form.get("message")?.toString()?.trim();
    if (email == null || email === "") {
      return page<InvitePageProps>({
        success: false,
        account,
        error: "emailRequired",
      });
    }
    const existingEmail = await db.query.accountEmailTable.findFirst({
      where: { email },
      with: { account: true },
    });
    if (existingEmail != null) {
      return page<InvitePageProps>({
        success: false,
        account,
        error: "alreadyExists",
        existingAccount: existingEmail.account,
      });
    }
    const token = await createSignupToken(kv, email, {
      inviterId: account.id,
      expiration: EXPIRATION,
    });
    const verifyUrl = new URL(
      `/sign/up/${token.token}`,
      ctx.state.canonicalOrigin,
    );
    verifyUrl.searchParams.set("code", token.code);
    const inviter = `${account.name} (@${account.username}@${
      new URL(ctx.state.canonicalOrigin).host
    })`;
    const t = getFixedT(language);
    await sendEmail({
      to: email,
      subject: t("settings.invite.invitationEmailSubject", {
        inviter,
        inviterName: account.name,
      }),
      text: message == null || message === ""
        ? t("settings.invite.invitationEmailText", {
          inviter,
          inviterName: account.name,
          verifyUrl: verifyUrl.href,
          expiration: EXPIRATION.toLocaleString(language, {
            // @ts-ignore: DurationFormatOptions, not DateTimeFormatOptions
            style: "long",
          }),
        })
        : t("settings.invite.invitationEmailTextWithMessage", {
          inviter,
          inviterName: account.name,
          message: `> ${message.replace(/\n/g, "\n> ")}`,
          verifyUrl: verifyUrl.href,
          expiration: EXPIRATION.toLocaleString(language, {
            // @ts-ignore: DurationFormatOptions, not DateTimeFormatOptions
            style: "long",
          }),
        }),
    });
    await db.update(accountTable).set({
      leftInvitations: sql`greatest(${accountTable.leftInvitations} - 1, 0)`,
    }).where(eq(accountTable.id, account.id));
    account.leftInvitations -= 1;
    return page<InvitePageProps>({
      success: true,
      account,
      email,
    });
  },
});

type InvitePageProps =
  & {
    account: Account & {
      inviter: Account & { actor: Actor } | null;
      invitees: (Account & { actor: Actor })[];
    };
  }
  & (
    | { success?: undefined }
    | { success: false; error: "noLeftInvitations" | "emailRequired" }
    | { success: false; error: "alreadyExists"; existingAccount: Account }
    | { success: true; email: string }
  );

export default define.page<typeof handler, InvitePageProps>(
  function InvitePage({ state, data: { account, ...data } }) {
    const { t, canonicalOrigin, language } = state;
    const { leftInvitations } = account;
    const languageDisplayNames = new Intl.DisplayNames(language, {
      type: "language",
    });
    return (
      <form method="post">
        <SettingsNav
          active="invite"
          settingsHref={`/@${account.username}/settings`}
          leftInvitations={leftInvitations}
        />
        {data.success === false
          ? (
            <p class="mt-4 text-red-700 dark:text-red-500">
              {data.error === "noLeftInvitations"
                ? <Msg $key="settings.invite.noLeftInvitations" />
                : data.error === "emailRequired"
                ? <Msg $key="settings.invite.emailRequired" />
                : data.error === "alreadyExists"
                ? (
                  <Msg
                    $key="settings.invite.alreadyExists"
                    account={
                      <a href={`/@${data.existingAccount.username}`}>
                        <strong>{data.existingAccount.name}</strong>
                        <span class="opacity-50 ml-1 before:content-['('] after:content-[')']">
                          @{data.existingAccount.username}@{new URL(
                            canonicalOrigin,
                          ).host}
                        </span>
                      </a>
                    }
                  />
                )
                : undefined}
            </p>
          )
          : (
            <p class="mt-4">
              {data.success
                ? (
                  <Msg
                    $key="settings.invite.success"
                    email={<strong>{data.email}</strong>}
                    count={leftInvitations}
                  />
                )
                : (
                  <Msg
                    $key="settings.invite.description"
                    count={leftInvitations}
                  />
                )}
            </p>
          )}
        <div class="mt-4 grid md:grid-cols-2 gap-5">
          <div>
            <Label label={t("settings.invite.email")} required>
              <Input
                type="email"
                name="email"
                required
                disabled={leftInvitations < 1}
                class="w-full"
              />
            </Label>
            <p class="opacity-50">
              <Msg $key="settings.invite.emailDescription" />
            </p>
          </div>
          <div>
            <Label label={t("settings.invite.language")} required>
              <select
                name="language"
                class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2"
              >
                {SUPPORTED_LANGUAGES
                  .map((l) =>
                    [l, languageDisplayNames.of(l) ?? l] satisfies [
                      Language,
                      string,
                    ]
                  )
                  .toSorted(([_, a], [__, b]) => a.localeCompare(b, language))
                  .map(([l, name]) => {
                    const nativeName = new Intl.DisplayNames(l, {
                      type: "language",
                    }).of(l);
                    return (
                      <option key={l} value={l} selected={l === language}>
                        {nativeName === name ? name : `${name} (${nativeName})`}
                      </option>
                    );
                  })}
              </select>
            </Label>
            <p class="opacity-50">
              <Msg $key="settings.invite.languageDescription" />
            </p>
          </div>
        </div>
        <div class="mt-4">
          <Label label={t("settings.invite.extraMessage")}>
            <TextArea
              name="message"
              rows={4}
              cols={80}
              disabled={leftInvitations < 1}
              class="w-full lg:w-auto"
            />
          </Label>
          <p class="opacity-50">
            <Msg $key="settings.invite.extraMessageDescription" />
          </p>
        </div>
        <div class="mt-4">
          <Button type="submit" disabled={leftInvitations < 1}>
            <Msg $key="settings.invite.send" />
          </Button>
        </div>
        {account.inviter != null && (
          <>
            <PageTitle class="mt-8">
              <Msg $key="settings.invite.inviter" />
            </PageTitle>
            <p>
              <a href={`/@${account.inviter.username}`}>
                <img
                  src={getAvatarUrl(account.inviter.actor)}
                  width={16}
                  height={16}
                  class="inline-block mr-1"
                />
                <strong>{account.inviter.name}</strong>
                <span class="opacity-50 before:content-['('] after:content-[')'] ml-1">
                  @{account.inviter.username}@{new URL(
                    state.canonicalOrigin,
                  ).host}
                </span>
              </a>
            </p>
          </>
        )}
        {account.invitees.length > 0 && (
          <>
            <PageTitle class="mt-8">
              <Msg $key="settings.invite.invitees" />
            </PageTitle>
            <ul>
              {account.invitees.map((invitee) => (
                <li key={invitee.id} class="mb-2">
                  <a href={`/@${invitee.username}`}>
                    <img
                      src={getAvatarUrl(invitee.actor)}
                      width={16}
                      height={16}
                      class="inline-block mr-1"
                    />
                    <strong>{invitee.name}</strong>
                    <span class="opacity-50 before:content-['('] after:content-[')'] ml-1">
                      @{invitee.username}@{new URL(state.canonicalOrigin).host}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
        <PageTitle class="mt-8">
          <Msg $key="settings.invite.tree" />
        </PageTitle>
        <p>
          <a href="/tree">
            <Msg $key="settings.invite.viewTree" />
          </a>
        </p>
      </form>
    );
  },
);
