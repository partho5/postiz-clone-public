/**
 * @jest-environment ./libraries/helpers/src/utils/jsdom.no.canvas.environment.cjs
 */
// Cost preview: every number comes from the server's quote, a free action shows nothing, the
// confirm control waits for the cost and says so when it cannot be had. Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' \
//     --transform '{"^.+\\.tsx?$":["ts-jest",{"isolatedModules":true,"tsconfig":{"jsx":"react-jsx","esModuleInterop":true}}]}' \
//     cost.preview
import { createElement } from 'react';
import { mutate, SWRConfig } from 'swr';
import { render, renderHook, screen, waitFor } from '@testing-library/react';

// What the screens ask the backend, answered per test by `answers`.
const calls: Array<{ path: string; method: string; body: any }> = [];
let answers: (path: string, body: any) => Response | Promise<Response>;

jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  // A fetch that records each call and answers it from `answers`.
  useFetch: () => async (path: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init?.method ?? 'GET', body });
    return answers(path, body);
  },
}));
jest.mock(
  '@gitroom/react/translation/get.transation.service.client',
  () => ({
    // Answers the English fallback of every key.
    useT: () => (_key: string, fallback: string) => fallback,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/cost/cost.request',
  () => jest.requireActual('./cost.request'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/cost/use.publish.cost',
  () => jest.requireActual('./use.publish.cost'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/cost/use.ai.cost',
  () => jest.requireActual('./use.ai.cost'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/cost/use.action.cost',
  () => jest.requireActual('./use.action.cost'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/cost/cost.label',
  () => jest.requireActual('./cost.label'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/cost/ai.cost.line',
  () => jest.requireActual('./ai.cost.line'),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/credits/cost/publish.cost.button',
  () => jest.requireActual('./publish.cost.button'),
  { virtual: true }
);
// The real shared button, so the controls under test are disabled by the same component the app renders.
jest.mock(
  '@gitroom/react/form/button',
  () =>
    jest.requireActual(
      '../../../../../../libraries/react-shared-libraries/src/form/button'
    ),
  { virtual: true }
);
jest.mock(
  '@gitroom/react/helpers/delete.dialog',
  () => ({
    // Answers the confirmation dialog with "yes".
    deleteDialog: async () => true,
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/frontend/components/agents/agent.textarea',
  () => {
    const { forwardRef, createElement } = require('react');
    return {
      __esModule: true,
      // A plain textarea standing in for the auto-resizing one.
      default: forwardRef(({ maxRows, ...props }: any, ref: any) =>
        createElement('textarea', { ...props, ref })
      ),
    };
  },
  { virtual: true }
);
jest.mock('@copilotkit/react-core', () => ({
  useCopilotChatInternal: () => ({ interrupt: undefined }),
  useCopilotContext: () => ({ copilotApiConfig: {} }),
  useCopilotReadable: () => undefined,
}));
jest.mock('@copilotkit/react-ui', () => ({
  useChatContext: () => ({
    icons: { sendIcon: 'send', stopIcon: 'stop', uploadIcon: 'upload' },
    labels: { placeholder: 'Type a message' },
  }),
}));

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { fireEvent } from '@testing-library/react';
import { CostLabel } from './cost.label';
import { AiCostLine } from './ai.cost.line';
import { ActionCostNote } from './action.cost.note';
import { publishCostButton } from './publish.cost.button';
import { SeparatePost } from '../../launches/separate.post';
import { Input as AssistantInput } from '../../agents/agent.input';
import { usePublishCost, usePublishCostButton } from './use.publish.cost';
import { useAiCost } from './use.ai.cost';
import { useActionCost } from './use.action.cost';

// The answer the backend gives, in the shape of the `Response` parts the hooks read (jsdom has none).
const reply = (status: number, body?: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    // Reads the body the test gave.
    json: async () => body,
  }) as unknown as Response;

// Requests the test left open on purpose; each is settled after the test, because SWR keeps an
// in-flight request per key and would hand it to the next test that asks the same thing.
const open: (() => void)[] = [];

// A request that gets no answer until the test is over.
const unanswered = () =>
  new Promise<Response>((resolve) => {
    open.push(() => resolve(reply(500, {})));
  });

// A fresh SWR scope for a hook or screen: no deduping, so each test asks the server itself.
const wrapper = ({ children }: { children?: any }) =>
  createElement(SWRConfig, { value: { dedupingInterval: 0 } }, children);

// The text a translation key falls back to.
const t = (_key: string, fallback: string) => fallback;

describe('cost preview', () => {
  beforeEach(async () => {
    calls.length = 0;
    await mutate(() => true, undefined, { revalidate: false });
  });

  afterEach(async () => {
    open.splice(0).forEach((settle) => settle());
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  describe('CostLabel', () => {
    it('shows a pending mark while the cost is not known', () => {
      render(createElement(CostLabel, { amount: undefined }));
      expect(screen.getByText('…')).toBeTruthy();
    });

    it('shows nothing for a free action', () => {
      const view = render(createElement(CostLabel, { amount: 0 }));
      expect(view.container.textContent).toBe('');
    });

    it.each([
      [1, '1 credit'],
      [3, '3 credits'],
    ])('reads %s as "%s"', (amount, text) => {
      render(createElement(CostLabel, { amount }));
      expect(screen.getByText(text)).toBeTruthy();
    });
  });

  describe('publishCostButton', () => {
    it('is untouched for a draft, a set or no channel chosen', () => {
      expect(
        publishCostButton({ applies: false, channels: 2, cost: { amount: 2 } }, t)
      ).toEqual({ blocked: false });
      expect(
        publishCostButton({ applies: true, channels: 0 }, t)
      ).toEqual({ blocked: false });
    });

    it('holds the button back, with a pending mark, until the cost has loaded', () => {
      expect(publishCostButton({ applies: true, channels: 2 }, t)).toEqual({
        blocked: true,
        text: '…',
      });
    });

    it('holds the button back and says the cost is unavailable when the quote failed', () => {
      expect(
        publishCostButton({ applies: true, channels: 2, error: new Error('x') }, t)
      ).toEqual({ blocked: true, text: 'Cost unavailable' });
    });

    it('reads "Publish to N channels: M credits" with the server amount', () => {
      expect(
        publishCostButton({ applies: true, channels: 3, cost: { amount: 3 } }, t)
      ).toEqual({ blocked: false, text: 'Publish to 3 channels: 3 credits' });
      expect(
        publishCostButton({ applies: true, channels: 1, cost: { amount: 1 } }, t)
      ).toEqual({ blocked: false, text: 'Publish to 1 channel: 1 credit' });
    });

    it('shows no cost when the server says the publish is free', () => {
      expect(
        publishCostButton({ applies: true, channels: 2, cost: { amount: 0 } }, t)
      ).toEqual({ blocked: false });
    });
  });

  describe('usePublishCost', () => {
    it('asks POST /posts/charge-preview with the group and channels and returns the server amount', async () => {
      answers = () => reply(200, { amount: 2, newChannels: ['a', 'b'], releasedChannels: [] });

      const { result } = renderHook(
        () => usePublishCost({ group: 'g1', integrationIds: ['a', 'b'] }),
        { wrapper }
      );

      await waitFor(() => expect(result.current.data).toEqual({ amount: 2, newChannels: ['a', 'b'], releasedChannels: [] }));
      expect(calls).toEqual([
        {
          path: '/posts/charge-preview',
          method: 'POST',
          body: { group: 'g1', integrationIds: ['a', 'b'] },
        },
      ]);
    });

    it('asks nothing while no channel is chosen', async () => {
      answers = () => reply(200, { amount: 0 });

      const { result } = renderHook(
        () => usePublishCost({ integrationIds: [] }),
        { wrapper }
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toHaveLength(0);
      expect(result.current.data).toBeUndefined();
    });

    it('reports an error, not an amount, when the server refuses the preview', async () => {
      answers = () => reply(500, { message: 'boom' });

      const { result } = renderHook(
        () => usePublishCost({ integrationIds: ['a'] }),
        { wrapper }
      );

      await waitFor(() => expect(result.current.error).toBeTruthy());
      expect(result.current.data).toBeUndefined();
    });
  });

  describe('useAiCost', () => {
    it('asks POST /ai/quote with the request and returns the server estimate', async () => {
      const estimate = {
        actionKey: 'ai.video.per_second',
        unitCost: 2,
        units: 8,
        amount: 16,
        cap: { limit: 25, used: 4 },
      };
      answers = () => reply(200, estimate);

      const { result } = renderHook(
        () =>
          useAiCost({
            kind: 'video',
            videoType: 'seedance',
            videoParams: { prompt: 'x' },
          }),
        { wrapper }
      );

      await waitFor(() => expect(result.current.data).toEqual(estimate));
      expect(calls).toEqual([
        {
          path: '/ai/quote',
          method: 'POST',
          body: {
            kind: 'video',
            videoType: 'seedance',
            videoParams: { prompt: 'x' },
          },
        },
      ]);
    });

    it('reports an error when the quote fails', async () => {
      answers = () => reply(400, { message: 'bad' });

      const { result } = renderHook(() => useAiCost({ kind: 'image' }), {
        wrapper,
      });

      await waitFor(() => expect(result.current.error).toBeTruthy());
    });
  });

  describe('useActionCost', () => {
    it('asks POST /credits/quote with the action key and quantity', async () => {
      answers = () =>
        reply(200, { actionKey: 'channel.connect', unitCost: 2, quantity: 3, amount: 6 });

      const { result } = renderHook(() => useActionCost('channel.connect', 3), {
        wrapper,
      });

      await waitFor(() => expect(result.current.data?.amount).toBe(6));
      expect(calls).toEqual([
        {
          path: '/credits/quote',
          method: 'POST',
          body: { actionKey: 'channel.connect', quantity: 3 },
        },
      ]);
    });

    it('leaves the quantity out when none is given', async () => {
      answers = () => reply(200, { amount: 0 });

      renderHook(() => useActionCost('brand.create'), { wrapper });

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0].body).toEqual({ actionKey: 'brand.create' });
    });
  });

  describe('AiCostLine', () => {
    // An AI estimate as the server states it, with the fields a test changes.
    const estimate = (over: Record<string, unknown> = {}) => ({
      actionKey: 'ai.image',
      unitCost: 5,
      units: 1,
      amount: 5,
      cap: null,
      ...over,
    });

    it('shows the cost, and nothing about a cap on a plan without one', () => {
      render(createElement(AiCostLine, { estimate: estimate() }));

      expect(screen.getByText('5 credits')).toBeTruthy();
      expect(screen.queryByText(/free AI credits used/)).toBeNull();
    });

    it('shows how much of the free plan cap is used this month', () => {
      render(
        createElement(AiCostLine, {
          estimate: estimate({ cap: { limit: 25, used: 4 } }),
        })
      );

      expect(screen.getByText('5 credits')).toBeTruthy();
      expect(
        screen.getByText('4 of 25 free AI credits used this month')
      ).toBeTruthy();
    });

    it('shows a pending mark before the estimate arrives', () => {
      render(createElement(AiCostLine, {}));
      expect(screen.getByText('…')).toBeTruthy();
    });

    it('says the cost is unavailable when the quote failed', () => {
      render(createElement(AiCostLine, { error: new Error('x') }));
      expect(screen.getByText('Cost unavailable')).toBeTruthy();
    });

    it('shows nothing for a free request', () => {
      const view = render(
        createElement(AiCostLine, { estimate: estimate({ amount: 0, cap: { limit: 25, used: 4 } }) })
      );
      expect(view.container.textContent).toBe('');
    });
  });

  describe('ActionCostNote', () => {
    // Mounts the channel-connect price note with a fresh SWR scope.
    const mountNote = () =>
      render(
        createElement(
          SWRConfig,
          { value: { dedupingInterval: 0 } },
          createElement(ActionCostNote, {
            actionKey: 'channel.connect',
            label: 'Connecting a channel costs',
          })
        )
      );

    it('shows nothing when the configured price is 0', async () => {
      answers = () => reply(200, { amount: 0 });
      const view = mountNote();

      await waitFor(() => expect(calls).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(view.container.textContent).toBe('');
    });

    it('names the price when it is above 0', async () => {
      answers = () => reply(200, { amount: 4 });
      mountNote();

      await screen.findByText('4 credits');
      expect(screen.getByText(/Connecting a channel costs/)).toBeTruthy();
    });

    it('says the cost is unavailable when the quote failed', async () => {
      answers = () => reply(500, {});
      mountNote();

      await screen.findByText('Cost unavailable');
    });
  });

  describe('usePublishCostButton', () => {
    it('holds the confirm back with a pending mark until the quote has loaded', () => {
      answers = () => unanswered();

      const { result } = renderHook(
        () =>
          usePublishCostButton({ integrationIds: ['a', 'b'], applies: true }, t),
        { wrapper }
      );

      expect(result.current).toEqual({ blocked: true, text: '…' });
    });

    it('says the cost is unavailable and stays held back when the quote fails', async () => {
      answers = () => reply(500, {});

      const { result } = renderHook(
        () =>
          usePublishCostButton({ integrationIds: ['a', 'b'], applies: true }, t),
        { wrapper }
      );

      await waitFor(() =>
        expect(result.current).toEqual({
          blocked: true,
          text: 'Cost unavailable',
        })
      );
    });

    it('reads the server amount for the chosen channels once it has loaded', async () => {
      answers = () => reply(200, { amount: 2 });

      const { result } = renderHook(
        () =>
          usePublishCostButton(
            { group: 'g1', integrationIds: ['a', 'b'], applies: true },
            t
          ),
        { wrapper }
      );

      await waitFor(() =>
        expect(result.current).toEqual({
          blocked: false,
          text: 'Publish to 2 channels: 2 credits',
        })
      );
      expect(calls[0].body).toEqual({ group: 'g1', integrationIds: ['a', 'b'] });
    });

    it('asks nothing and never holds back a draft or a set', async () => {
      answers = () => reply(200, { amount: 2 });

      const { result } = renderHook(
        () =>
          usePublishCostButton({ integrationIds: ['a'], applies: false }, t),
        { wrapper }
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toHaveLength(0);
      expect(result.current).toEqual({ blocked: false });
    });
  });

  describe('publish button wording', () => {
    // The app's English resources, as `t` reads them: the locale's entry, else the fallback.
    const english = JSON.parse(
      readFileSync(
        resolvePath(
          __dirname,
          '../../../../../../libraries/react-shared-libraries/src/translation/locales/en/translation.json'
        ),
        'utf8'
      )
    ) as Record<string, string>;
    const real = (key: string, fallback: string) => english[key] ?? fallback;

    it('reads "Publish to N channels: M credits" through the real English resources', () => {
      expect(
        publishCostButton(
          { applies: true, channels: 3, cost: { amount: 3 } },
          real
        ).text
      ).toBe('Publish to 3 channels: 3 credits');
      expect(
        publishCostButton(
          { applies: true, channels: 1, cost: { amount: 1 } },
          real
        ).text
      ).toBe('Publish to 1 channel: 1 credit');
    });
  });

  describe('a wired AI control (separate posts)', () => {
    // Mounts the control with a fresh SWR scope and returns its button.
    const mountSeparate = () => {
      render(
        createElement(
          SWRConfig,
          { value: { dedupingInterval: 0 } },
          createElement(SeparatePost, {
            posts: ['a', 'b'],
            len: 100,
            merge: () => undefined,
            changeLoading: () => undefined,
          })
        )
      );
      return screen
        .getByText('Separate post to multiple posts')
        .closest('button') as HTMLButtonElement;
    };

    it('is disabled with a pending mark while the cost has not loaded', () => {
      answers = () => unanswered();
      const button = mountSeparate();

      expect(button.disabled).toBe(true);
      expect(screen.getByText('…')).toBeTruthy();
    });

    it('stays disabled and says the cost is unavailable when the quote fails', async () => {
      answers = () => reply(500, {});
      const button = mountSeparate();

      await screen.findByText('Cost unavailable');
      expect(button.disabled).toBe(true);
    });

    it('shows the server cost and is enabled once it has loaded', async () => {
      answers = () =>
        reply(200, {
          actionKey: 'ai.text',
          unitCost: 1,
          units: 1,
          amount: 1,
          cap: null,
        });
      const button = mountSeparate();

      await screen.findByText('1 credit');
      expect(button.disabled).toBe(false);
      expect(calls[0]).toMatchObject({
        path: '/ai/quote',
        body: { kind: 'text' },
      });
    });
  });

  describe('the assistant input (agents chat and the post-editor popup)', () => {
    // Mounts the input with text typed and returns its send button and the send spy.
    const mountInput = () => {
      const onSend = jest.fn();
      const view = render(
        createElement(
          SWRConfig,
          { value: { dedupingInterval: 0 } },
          createElement(AssistantInput, {
            inProgress: false,
            onSend,
            isVisible: true,
          } as any)
        )
      );
      fireEvent.change(screen.getByPlaceholderText('Type a message'), {
        target: { value: 'hello' },
      });
      const send = view.container.querySelector(
        '[data-test-id="copilot-chat-ready"]'
      ) as HTMLButtonElement;
      return { send, onSend };
    };

    it('cannot send while the cost has not loaded', () => {
      answers = () => unanswered();
      const { send, onSend } = mountInput();

      expect(send.disabled).toBe(true);
      fireEvent.click(send);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('cannot send, and says the cost is unavailable, when the quote fails', async () => {
      answers = () => reply(500, {});
      const { send, onSend } = mountInput();

      await screen.findByText('Cost unavailable');
      expect(send.disabled).toBe(true);
      fireEvent.click(send);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('shows the server cost and sends once it has loaded', async () => {
      answers = () =>
        reply(200, {
          actionKey: 'ai.text',
          unitCost: 1,
          units: 1,
          amount: 1,
          cap: { limit: 25, used: 4 },
        });
      const { send, onSend } = mountInput();

      await screen.findByText('1 credit');
      expect(
        screen.getByText('4 of 25 free AI credits used this month')
      ).toBeTruthy();
      await waitFor(() => expect(send.disabled).toBe(false));
      fireEvent.click(send);
      expect(onSend).toHaveBeenCalledWith('hello');
    });
  });
});
