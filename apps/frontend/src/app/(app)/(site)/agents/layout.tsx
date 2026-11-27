import { Metadata } from 'next';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Agent } from '@gitroom/frontend/components/agents/agent';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} - Agent`,
  description: 'agents',
};
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Agent>{children}</Agent>;
}
