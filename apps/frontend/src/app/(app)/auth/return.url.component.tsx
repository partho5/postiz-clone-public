'use client';

import { useSearchParams } from 'next/navigation';
import { FC, useCallback, useEffect } from 'react';

// A saved return address is used only when it is a web address of this site: another site's address, or a
// `javascript:` one, would otherwise send the person (or run a script) after signing in.
const isOwnAddress = (url: string | null): url is string => {
  try {
    const address = new URL(url!);
    return (
      (address.protocol === 'http:' || address.protocol === 'https:') &&
      address.host === window.location.host
    );
  } catch (e) {
    return false;
  }
};

const ReturnUrlComponent: FC = () => {
  const params = useSearchParams();
  const url = params.get('returnUrl');
  useEffect(() => {
    if (isOwnAddress(url)) {
      localStorage.setItem('returnUrl', url);
    }
  }, [url]);
  return null;
};
export const useReturnUrl = () => {
  return {
    getAndClear: useCallback(() => {
      const data = localStorage.getItem('returnUrl');
      localStorage.removeItem('returnUrl');
      return isOwnAddress(data) ? data : null;
    }, []),
  };
};
export default ReturnUrlComponent;
