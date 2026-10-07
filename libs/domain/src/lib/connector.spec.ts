import {
  CONNECTOR_CLIENTS,
  connectorClient,
  connectorErrorRedirect,
  connectorRedirectAllowed,
  connectorServerUrl,
  connectorToolAllowed,
  parseConnectorAuthorization,
  parseConnectorScopes,
  type ConnectorClient,
} from './connector';
import { resolveConnectorSettings } from './connector-settings';

const RESOURCE = 'https://materia-v2-dev.web.app/mcp';
const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const params = (overrides: Record<string, string | undefined> = {}) => ({
  response_type: 'code',
  client_id: CLAUDE,
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  state: 'state-123',
  resource: RESOURCE,
  ...overrides,
});

describe('Claude connector (INT-07)', () => {
  it('names the MCP server URL from the app origin', () => {
    expect(connectorServerUrl('https://materia-v2-dev.web.app/')).toBe(RESOURCE);
  });

  it('pins Claude and Claude Code only', () => {
    expect(CONNECTOR_CLIENTS.map((client) => client.name)).toEqual(['Claude', 'Claude Code']);
    expect(connectorClient(CLAUDE)?.name).toBe('Claude');
    expect(connectorClient('https://evil.example/client')).toBeUndefined();
    expect(connectorClient(undefined)).toBeUndefined();
  });

  describe('redirect URIs', () => {
    const claude = CONNECTOR_CLIENTS.find((client) => client.id === CLAUDE) as ConnectorClient;
    const code = CONNECTOR_CLIENTS.find((client) => client.id === CLAUDE_CODE) as ConnectorClient;

    it('matches a web client’s redirect exactly', () => {
      expect(connectorRedirectAllowed(claude, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
      expect(connectorRedirectAllowed(claude, 'https://claude.com/api/mcp/auth_callback')).toBe(true);
      expect(connectorRedirectAllowed(claude, 'https://claude.ai/api/mcp/auth_callback?x=1')).toBe(false);
      expect(connectorRedirectAllowed(claude, 'https://claude.ai.evil.example/api/mcp/auth_callback')).toBe(false);
      expect(connectorRedirectAllowed(claude, 'http://localhost:3000/callback')).toBe(false);
    });

    it('lets Claude Code use any loopback port, and nothing else', () => {
      expect(connectorRedirectAllowed(code, 'http://localhost/callback')).toBe(true);
      expect(connectorRedirectAllowed(code, 'http://localhost:54321/callback')).toBe(true);
      expect(connectorRedirectAllowed(code, 'http://127.0.0.1:8080/callback')).toBe(true);
      expect(connectorRedirectAllowed(code, 'https://localhost:8080/callback')).toBe(false);
      expect(connectorRedirectAllowed(code, 'http://localhost:8080/other')).toBe(false);
      expect(connectorRedirectAllowed(code, 'http://localhost:8080/callback?next=x')).toBe(false);
      expect(connectorRedirectAllowed(code, 'http://user@localhost:8080/callback')).toBe(false);
      expect(connectorRedirectAllowed(code, 'http://example.com:8080/callback')).toBe(false);
      expect(connectorRedirectAllowed(code, 'not a url')).toBe(false);
    });
  });

  describe('scopes', () => {
    it('keeps known scopes in order, ignoring others; none means all', () => {
      expect(parseConnectorScopes('materia.propose materia.read openid')).toEqual(['materia.read', 'materia.propose']);
      expect(parseConnectorScopes('materia.read')).toEqual(['materia.read']);
      expect(parseConnectorScopes('')).toEqual(['materia.read', 'materia.propose']);
      expect(parseConnectorScopes('openid profile')).toEqual(['materia.read', 'materia.propose']);
      expect(parseConnectorScopes(undefined)).toEqual(['materia.read', 'materia.propose']);
    });
  });

  describe('the authorization request', () => {
    it('accepts a well-formed request', () => {
      const result = parseConnectorAuthorization(params(), RESOURCE);
      expect(result).toEqual({
        ok: true,
        request: {
          client: connectorClient(CLAUDE),
          redirectUri: 'https://claude.ai/api/mcp/auth_callback',
          codeChallenge: CHALLENGE,
          scopes: ['materia.read', 'materia.propose'],
          state: 'state-123',
          resource: RESOURCE,
        },
      });
      expect(parseConnectorAuthorization(params({ resource: `${RESOURCE}/` }), RESOURCE).ok).toBe(true);
      expect(parseConnectorAuthorization(params({ resource: undefined, state: undefined }), RESOURCE).ok).toBe(true);
    });

    it('shows an error, sending the browser nowhere, for an unknown client or redirect', () => {
      expect(parseConnectorAuthorization(params({ client_id: 'https://evil.example/c' }), RESOURCE)).toEqual({
        ok: false,
        redirect: false,
        error: 'invalid_client',
      });
      expect(parseConnectorAuthorization(params({ redirect_uri: 'https://evil.example/cb' }), RESOURCE)).toEqual({
        ok: false,
        redirect: false,
        error: 'invalid_redirect_uri',
      });
    });

    it('sends other errors back to the client with its state', () => {
      const cases: [Record<string, string | undefined>, string][] = [
        [{ response_type: 'token' }, 'unsupported_response_type'],
        [{ code_challenge_method: 'plain' }, 'invalid_request'],
        [{ code_challenge: undefined }, 'invalid_request'],
        [{ code_challenge: 'short' }, 'invalid_request'],
        [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
        [{ state: 'x'.repeat(1001) }, 'invalid_request'],
      ];
      for (const [overrides, error] of cases) {
        const result = parseConnectorAuthorization(params(overrides), RESOURCE);
        expect(result, JSON.stringify(overrides)).toMatchObject({ ok: false, redirect: true, error });
      }
      expect(parseConnectorAuthorization(params({ response_type: 'token' }), RESOURCE)).toMatchObject({
        state: 'state-123',
        redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      });
    });

    it('builds the error redirect', () => {
      const url = new URL(
        connectorErrorRedirect('https://claude.ai/api/mcp/auth_callback', 'access_denied', {
          state: 's',
          issuer: 'https://materia-v2-dev.web.app',
        }),
      );
      expect(url.origin + url.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        error: 'access_denied',
        state: 's',
        iss: 'https://materia-v2-dev.web.app',
      });
    });
  });

  it('keeps the connector off until a practice turns it on, with suggestions allowed by default', () => {
    expect(resolveConnectorSettings(undefined)).toEqual({ enabled: false, allowProposals: true });
    expect(resolveConnectorSettings({ enabled: true })).toEqual({ enabled: true, allowProposals: true });
    expect(resolveConnectorSettings({ enabled: true, allowProposals: false })).toEqual({
      enabled: true,
      allowProposals: false,
    });
    expect(resolveConnectorSettings({ enabled: 'yes' })).toEqual({ enabled: false, allowProposals: true });
  });

  it('offers read tools to every role and proposals to roles that could make the change', () => {
    expect(connectorToolAllowed('readonly', 'search_matters')).toBe(true);
    expect(connectorToolAllowed('readonly', 'propose_task')).toBe(false);
    expect(connectorToolAllowed('paralegal', 'propose_time_entry')).toBe(true);
    expect(connectorToolAllowed('lawyer', 'propose_note')).toBe(true);
  });
});
