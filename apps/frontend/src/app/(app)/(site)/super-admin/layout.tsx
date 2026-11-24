import { SuperAdminShell } from '@gitroom/frontend/components/super-admin/super.admin.shell';

// Every page of the super admin area; the proxy lets only a super admin reach /super-admin.
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SuperAdminShell>{children}</SuperAdminShell>;
}
