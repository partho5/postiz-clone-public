import { PlansComponent } from '@gitroom/frontend/components/billing/plans/plans.component';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { Logo } from '@gitroom/frontend/components/new-layout/logo';
import { LogoutComponent } from '@gitroom/frontend/components/layout/logout.component';
import React from 'react';
import { OrganizationSelector } from '@gitroom/frontend/components/layout/organization.selector';

// Shows the plans screen for an account that must pick a plan, under the logo.
export const BillingAfter = () => {
  const { isGeneral, billingEnabled } = useVariables();
  return (
    <div className="flex-1 rounded-3xl px-0 py-[17px] flex flex-col max-w-[1440px] mx-auto">
      <div>
        <OrganizationSelector asOpenSelect={true} />
      </div>
      <div className="flex justify-center mb-[10px]">
        <Logo />
      </div>
      <PlansComponent />
      <div className="flex justify-center items-center mt-[20px]">
        <LogoutComponent />
      </div>
    </div>
  );
};
