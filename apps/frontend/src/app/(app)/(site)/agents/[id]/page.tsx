import { Metadata } from 'next';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Agent } from '@gitroom/frontend/components/agents/agent';
import { AgentChat } from '@gitroom/frontend/components/agents/agent.chat';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} - Agent`,
  description: '',
};
export default async function Page() {
  return (
    <AgentChat />
  );
}
