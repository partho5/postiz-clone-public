'use client';

import { useState, useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { useUser } from '../layout/user.context';
import { CopyButton } from '@gitroom/react/form/copy.button';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { DeveloperComponent } from '@gitroom/frontend/components/developer/developer.component';
import { ApiKeysComponent } from '@gitroom/frontend/components/settings/api-keys/api.keys.component';
import { McpClientIcon } from '@gitroom/frontend/components/public-api/mcp.client.icons';
import clsx from 'clsx';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';

// The name each MCP client registers this product's server under
const MCP_SERVER_ID = PRODUCT_NAME.toLowerCase().replace(/\s+/g, '-');

// Remote clients can't set headers, they get a URL to paste (hint = where)
export const remoteMcpClients = {
  Claude:
    'In Claude go to Settings > Connectors > Add custom connector and paste this URL.',
  ChatGPT:
    'In ChatGPT go to Settings > Connectors > Create and paste this URL.',
} as const;

export const mcpClients = [
  'OpenClaw',
  'Hermes',
  'NanoClaw',
  'Claude Code',
  'Cursor',
  'Codex',
  'VS Code / Copilot',
  'Windsurf',
  'Amp',
  'Gemini CLI',
  'Warp',
] as const;

export type RemoteMcpClient = keyof typeof remoteMcpClients;
export type McpClient = (typeof mcpClients)[number];
export type AnyMcpClient = RemoteMcpClient | McpClient;

// oauth: no API key, the client registers itself (DCR) and the user signs in to the product
// apikey: the organization API key, as a Bearer header (or inside the URL for remote clients)
export type McpAuth = 'oauth' | 'apikey';

export const getMcpOauthUrl = (mcpBase: string) =>
  `${mcpBase}/mcp-oauth-dynamic`;

export const isRemoteMcpClient = (client: string): client is RemoteMcpClient =>
  client in remoteMcpClients;

// Builds the configuration text and hint a given MCP client needs to connect to this product.
export const getMcpConfig = (
  client: AnyMcpClient,
  auth: McpAuth,
  mcpBase: string,
  apiKey: string
): { config: string; hint: string } => {
  if (isRemoteMcpClient(client)) {
    return {
      config:
        auth === 'oauth' ? getMcpOauthUrl(mcpBase) : `${mcpBase}/mcp/${apiKey}`,
      hint: remoteMcpClients[client],
    };
  }

  const oauthUrl = getMcpOauthUrl(mcpBase);
  const urlBase = `${mcpBase}/mcp`;
  const bearer = `Bearer ${apiKey}`;

  const json = (obj: object) => JSON.stringify(obj, null, 2);

  if (auth === 'oauth') {
    switch (client) {
      case 'Claude Code':
        return {
          config: `claude mcp add ${MCP_SERVER_ID} --transport http "${oauthUrl}"`,
          hint: 'Run this command in your terminal.',
        };
      case 'Cursor':
        return {
          config: json({ mcpServers: { [MCP_SERVER_ID]: { url: oauthUrl } } }),
          hint: 'Add to .cursor/mcp.json in your project root.',
        };
      case 'VS Code / Copilot':
        return {
          config: json({
            servers: { [MCP_SERVER_ID]: { type: 'http', url: oauthUrl } },
          }),
          hint: 'Add to .vscode/mcp.json in your project root.',
        };
      case 'Windsurf':
        return {
          config: json({
            mcpServers: { [MCP_SERVER_ID]: { serverUrl: oauthUrl } },
          }),
          hint: 'Add to ~/.codeium/windsurf/mcp_config.json',
        };
      case 'Amp':
        return {
          config: `amp mcp add ${MCP_SERVER_ID} ${oauthUrl}`,
          hint: 'Run this command in your terminal.',
        };
      case 'Codex':
        return {
          config: `# ~/.codex/config.toml\n\n[mcp_servers.${MCP_SERVER_ID}]\nurl = "${oauthUrl}"`,
          hint: `Add to ~/.codex/config.toml, then run: codex mcp login ${MCP_SERVER_ID}`,
        };
      case 'Gemini CLI':
        return {
          config: json({ mcpServers: { [MCP_SERVER_ID]: { url: oauthUrl } } }),
          hint: 'Add to ~/.gemini/settings.json',
        };
      case 'Warp':
        return {
          config: json({ [MCP_SERVER_ID]: { url: oauthUrl } }),
          hint: 'Settings > MCP Servers > + Add, then paste this config.',
        };
      case 'Hermes':
        return {
          config: `# ~/.hermes/config.yaml\n\nmcp_servers:\n  ${MCP_SERVER_ID}:\n    url: "${oauthUrl}"\n    auth: oauth`,
          hint: 'Add to ~/.hermes/config.yaml, then run /reload-mcp in the chat.',
        };
      case 'OpenClaw':
        return {
          config: `openclaw mcp add ${MCP_SERVER_ID} --url ${oauthUrl} --transport streamable-http --auth oauth && openclaw mcp login ${MCP_SERVER_ID}`,
          hint: 'Run this command in your terminal.',
        };
      case 'NanoClaw':
        return {
          config: `ncl groups config add-mcp-server --id <group-id> --name ${MCP_SERVER_ID} --url ${oauthUrl}`,
          hint: `Run this in your terminal, replace <group-id> with the agent group that should get ${PRODUCT_NAME}.`,
        };
    }
  }

  switch (client) {
    case 'Claude Code':
      return {
        config: `claude mcp add --transport http ${MCP_SERVER_ID} ${urlBase} --header "Authorization: ${bearer}"`,
        hint: 'Run this command in your terminal.',
      };
    case 'Cursor':
      return {
        config: json({
          mcpServers: {
            [MCP_SERVER_ID]: { url: urlBase, headers: { Authorization: bearer } },
          },
        }),
        hint: 'Add to .cursor/mcp.json in your project root.',
      };
    case 'VS Code / Copilot':
      return {
        config: json({
          servers: {
            [MCP_SERVER_ID]: {
              type: 'http',
              url: urlBase,
              headers: { Authorization: bearer },
            },
          },
        }),
        hint: 'Add to .vscode/mcp.json in your project root.',
      };
    case 'Windsurf':
      return {
        config: json({
          mcpServers: {
            [MCP_SERVER_ID]: {
              serverUrl: urlBase,
              headers: { Authorization: bearer },
            },
          },
        }),
        hint: 'Add to ~/.codeium/windsurf/mcp_config.json',
      };
    case 'Amp':
      return {
        config: json({
          'amp.mcpServers': {
            [MCP_SERVER_ID]: { url: urlBase, headers: { Authorization: bearer } },
          },
        }),
        hint: 'Add to your Amp settings.json',
      };
    case 'Codex':
      return {
        config: `# ~/.codex/config.toml\n\n[mcp_servers.${MCP_SERVER_ID}]\nurl = "${urlBase}"\nhttp_headers = { "Authorization" = "${bearer}" }`,
        hint: 'Add to ~/.codex/config.toml',
      };
    case 'Gemini CLI':
      return {
        config: json({
          mcpServers: {
            [MCP_SERVER_ID]: { url: urlBase, headers: { Authorization: bearer } },
          },
        }),
        hint: 'Add to ~/.gemini/settings.json',
      };
    case 'Warp':
      return {
        config: json({
          [MCP_SERVER_ID]: { url: urlBase, headers: { Authorization: bearer } },
        }),
        hint: 'Settings > MCP Servers > + Add, then paste this config.',
      };
    case 'Hermes':
      return {
        config: `# ~/.hermes/config.yaml\n\nmcp_servers:\n  ${MCP_SERVER_ID}:\n    url: "${urlBase}"\n    headers:\n      Authorization: "${bearer}"`,
        hint: 'Add to ~/.hermes/config.yaml, then run /reload-mcp in the chat.',
      };
    case 'OpenClaw':
      return {
        config: json({
          mcp: {
            servers: {
              [MCP_SERVER_ID]: {
                url: urlBase,
                transport: 'streamable-http',
                headers: { Authorization: bearer },
              },
            },
          },
        }),
        hint: 'Add to ~/.openclaw/openclaw.json',
      };
    case 'NanoClaw':
      // No headers flag, the key travels inside the URL like remote clients
      return {
        config: `ncl groups config add-mcp-server --id <group-id> --name ${MCP_SERVER_ID} --url ${mcpBase}/mcp/${apiKey}`,
        hint: `Run this in your terminal, replace <group-id> with the agent group that should get ${PRODUCT_NAME}.`,
      };
  }
};

// What the commands show in place of a key until the admin has just created one.
const NO_KEY_YET = 'YOUR_API_KEY';

// The MCP configuration of each client, built from the key the admin has just created (never a stored one).
const McpSection = ({
  apiKey,
  mcpBase,
}: {
  apiKey: string;
  mcpBase: string;
}) => {
  const t = useT();
  const [activeClient, setActiveClient] = useState<AnyMcpClient>('Claude');
  const [auth, setAuth] = useState<McpAuth>('oauth');
  const [revealed, setRevealed] = useState(false);

  const { config, hint } = getMcpConfig(
    activeClient,
    auth,
    mcpBase,
    apiKey || NO_KEY_YET
  );

  const baseUrl = auth === 'oauth' ? getMcpOauthUrl(mcpBase) : `${mcpBase}/mcp`;

  const maskedConfig =
    revealed || auth === 'oauth' || !apiKey
      ? config
      : config.replace(
          new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          '*'.repeat(apiKey.length)
        );

  return (
    <div className="bg-newBgColorInnerInner rounded-[12px] border border-newBorder overflow-hidden">
      <div className="bg-newBgColorInner px-[20px] py-[14px] border-b border-newBorder flex items-start justify-between gap-[12px]">
        <div>
          <div className="text-[15px] font-[600]">
            {t('mcp_client_configuration', 'MCP Client Configuration')}
          </div>
          <div className="text-[13px] text-customColor18 mt-[2px]">
            {t(
              'connect_your_mcp_client_to_postiz_to_schedule_your_posts_faster',
              'Connect {{productName}} MCP server to your client (Http streaming) to schedule your posts faster.'
            )}
          </div>
        </div>
      </div>
      <div className="p-[20px] flex flex-col gap-[16px]">
        <div className="flex flex-col gap-[6px]">
          <div className="text-[13px] font-[600] text-customColor18">
            {t('auth_method', 'Authentication')}
          </div>
          <div className="flex gap-[6px]">
            {(['oauth', 'apikey'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={clsx(
                  'cursor-pointer px-[14px] h-[36px] text-[13px] font-[500] rounded-[8px] transition-colors',
                  auth === m
                    ? 'bg-btnPrimary text-white'
                    : 'bg-btnSimple text-customColor18 hover:bg-boxHover hover:text-textColor'
                )}
                onClick={() => setAuth(m)}
              >
                {m === 'oauth'
                  ? t('sign_in_no_api_key', 'Sign in with {{productName}} (no API key)')
                  : t('api_key', 'API Key')}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-[6px]">
          <div className="text-[13px] font-[600] text-customColor18">
            {t('mcp_client', 'Client')}
          </div>
          <div className="flex flex-wrap gap-[6px]">
            {[
              ...Object.keys(remoteMcpClients),
              ...mcpClients,
            ].map((client) => (
              <button
                key={client}
                type="button"
                className={clsx(
                  'cursor-pointer px-[14px] h-[36px] text-[13px] font-[500] rounded-[8px] transition-colors flex items-center gap-[8px]',
                  activeClient === client
                    ? 'bg-btnPrimary text-white'
                    : 'bg-btnSimple text-customColor18 hover:bg-boxHover hover:text-textColor'
                )}
                onClick={() =>
                  setActiveClient(client as AnyMcpClient)
                }
              >
                <McpClientIcon client={client} />
                {client}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-[8px]">
          <div className="text-[12px] text-customColor18 font-[500]">
            {hint}
            {auth === 'oauth' &&
              ` ${t(
                'oauth_sign_in_hint',
                'Your agent will open a browser window to sign in to {{productName}}.'
              )}`}
          </div>
          <pre className="bg-newBgColorInner border border-newBorder rounded-[8px] p-[16px] text-[13px] whitespace-pre-wrap break-all overflow-x-auto leading-[1.6]">
            {maskedConfig}
          </pre>
          <div className="flex gap-[8px]">
            {auth === 'apikey' && (
              <button
                type="button"
                onClick={() => setRevealed(!revealed)}
                className="cursor-pointer px-[16px] h-[36px] bg-btnSimple hover:bg-boxHover transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {revealed ? (
                    <>
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </>
                  ) : (
                    <>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  )}
                </svg>
                {revealed ? t('hide', 'Hide') : t('reveal', 'Reveal')}
              </button>
            )}
            <CopyButton text={config} label={t('copy', 'Copy')} />
            {!isRemoteMcpClient(activeClient) && (
              <CopyButton text={baseUrl} label={t('copy_url', 'Copy URL')} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// The "Access" sub-tab: the API keys card, and the MCP setup built from the key just created.
const PublicApiContent = () => {
  const { backendUrl, mcpUrl } = useVariables();
  const t = useT();
  const [createdKey, setCreatedKey] = useState('');
  const mcpBase = mcpUrl || backendUrl;

  return (
    <div className="flex flex-col gap-[40px]">
      <div className="text-[14px] text-textColor leading-[1.7]">
        {t(
          'api_keys_note',
          'Use an API key to automate this workspace. A key works only here and only for the scopes you give it.'
        )}
        <br />
        {t(
          'api_auth_note_line2',
          'If you are building a product that schedules posts on behalf of other {{productName}} users,'
        )}
        <br />
        {t(
          'api_auth_note_line3',
          'create an OAuth App under the "Apps" tab. Your users will authorize your app via OAuth2,'
        )}
        <br />
        {t(
          'api_auth_note_line4',
          'and you will receive a pos_ prefixed token that works with the API and MCP — just like an API Key.'
        )}
      </div>

      <ApiKeysComponent createdKey={createdKey} onCreated={setCreatedKey} />

      <McpSection apiKey={createdKey} mcpBase={mcpBase} />
    </div>
  );
};

export const PublicComponent = () => {
  const t = useT();
  const fetch = useFetch();
  const user = useUser();
  const [subTab, setSubTab] = useState<'api' | 'developer'>('api');
  const loadOrganizations = useCallback(async () => {
    return await (await fetch('/user/organizations')).json();
  }, []);
  const { data: organizations } = useSWR('organizations', loadOrganizations, {
    revalidateIfStale: false,
    revalidateOnFocus: false,
    refreshWhenOffline: false,
    refreshWhenHidden: false,
    revalidateOnReconnect: false,
  });
  const currentOrg = useMemo(() => {
    return organizations?.find((org: any) => org?.id === user?.orgId);
  }, [organizations, user?.orgId]);

  return (
    <div className="flex flex-col gap-[20px]">
      <h3 className="text-[20px]">
        {t('developers', 'Developers')}
        {currentOrg?.name ? ` - ${currentOrg.name}` : ''}
      </h3>
      <div className="flex gap-[6px]">
        {(['api', 'developer'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={clsx(
              'cursor-pointer px-[20px] h-[44px] text-[15px] font-[600] rounded-[8px] transition-colors',
              subTab === tab
                ? 'bg-btnPrimary text-white'
                : 'bg-btnSimple text-customColor18 hover:bg-boxHover hover:text-textColor'
            )}
            onClick={() => setSubTab(tab)}
          >
            {tab === 'api'
              ? t('access', 'Access')
              : t('apps', 'Apps')}
          </button>
        ))}
      </div>
      {subTab === 'api' && <PublicApiContent />}
      {subTab === 'developer' && <DeveloperComponent />}
    </div>
  );
};
