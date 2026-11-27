// Feature: Application Navigation & Mobile Menu
'use client';

import { FC, ReactNode, useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { MenuItem } from '@gitroom/frontend/components/new-layout/menu-item';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { AgentMediaModal } from '@gitroom/frontend/components/layout/agent.media.modal';
import {
  useWorkspacePathname,
  WorkspaceLink,
} from '@gitroom/frontend/components/layout/workspace.navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { SetSelectionModal } from '@gitroom/frontend/components/launches/calendar';
import { AddEditModal } from '@gitroom/frontend/components/new-launch/add.edit.modal';
import { StreakComponent } from '@gitroom/frontend/components/layout/streak.component';
import { LanguageComponent } from '@gitroom/frontend/components/layout/language.component';
import { AttachToFeedbackIcon } from '@gitroom/frontend/components/new-layout/sentry.feedback.component';
import { BrandBadge } from '@gitroom/frontend/components/brand/switcher/brand.badge';
import {
  PRODUCT_LOGO_PATH,
  PRODUCT_NAME,
} from '@gitroom/helpers/brand/brand.identity';

dayjs.extend(utc);

interface MenuItemInterface {
  name: string;
  icon: ReactNode;
  path: string;
  role?: string[];
  hide?: boolean;
  requireBilling?: boolean;
  onClick?: () => void;
}

// Builds the side menu entries for the current user.
export const useMenuItem = () => {
  const { isGeneral } = useVariables();
  const user = useUser();
  const t = useT();
  const { openModal } = useModals();

  const handleAgentMediaClick = useCallback(() => {
    openModal({
      title: t('agent_media_title', 'UGC videos by AgentMedia'),
      closeOnClickOutside: true,
      closeOnEscape: true,
      children: <AgentMediaModal />,
    });
  }, [openModal, t]);

  const firstMenu = [
    {
      name: isGeneral ? t('calendar', 'Calendar') : t('launches', 'Launches'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="21"
          height="23"
          viewBox="0 0 21 23"
          fill="none"
        >
          <path
            d="M19.5 9.5H1.5M14.5 1.5V5.5M6.5 1.5V5.5M6.3 21.5H14.7C16.3802 21.5 17.2202 21.5 17.862 21.173C18.4265 20.8854 18.8854 20.4265 19.173 19.862C19.5 19.2202 19.5 18.3802 19.5 16.7V8.3C19.5 6.61984 19.5 5.77976 19.173 5.13803C18.8854 4.57354 18.4265 4.1146 17.862 3.82698C17.2202 3.5 16.3802 3.5 14.7 3.5H6.3C4.61984 3.5 3.77976 3.5 3.13803 3.82698C2.57354 4.1146 2.1146 4.57354 1.82698 5.13803C1.5 5.77976 1.5 6.61984 1.5 8.3V16.7C1.5 18.3802 1.5 19.2202 1.82698 19.862C2.1146 20.4265 2.57354 20.8854 3.13803 21.173C3.77976 21.5 4.61984 21.5 6.3 21.5Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/launches',
    },
    {
      name: 'Agent',
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="23"
          height="23"
          viewBox="0 0 32 32"
          fill="none"
        >
          <path
            d="M21.1963 9.07375C20.2913 6.95494 18.6824 5.21364 16.6416 4.14422C14.6009 3.0748 12.2534 2.74287 9.99616 3.20455C7.73891 3.66623 5.71031 4.8932 4.25334 6.67802C2.79637 8.46284 2.0004 10.696 2 13V21.25C2 21.7141 2.18437 22.1592 2.51256 22.4874C2.84075 22.8156 3.28587 23 3.75 23H10.8337C11.6141 24.7821 12.8964 26.2984 14.5241 27.3638C16.1519 28.4293 18.0546 28.9978 20 29H28.25C28.7141 29 29.1592 28.8156 29.4874 28.4874C29.8156 28.1592 30 27.7141 30 27.25V19C29.9995 16.5553 29.1036 14.1955 27.4814 12.3666C25.8593 10.5376 23.6234 9.36619 21.1963 9.07375ZM4 13C4 11.4177 4.46919 9.87103 5.34824 8.55544C6.22729 7.23984 7.47672 6.21446 8.93853 5.60896C10.4003 5.00346 12.0089 4.84504 13.5607 5.15372C15.1126 5.4624 16.538 6.22432 17.6569 7.34314C18.7757 8.46197 19.5376 9.88743 19.8463 11.4393C20.155 12.9911 19.9965 14.5997 19.391 16.0615C18.7855 17.5233 17.7602 18.7727 16.4446 19.6518C15.129 20.5308 13.5823 21 12 21H4V13ZM28 27H20C18.5854 26.9984 17.1964 26.6225 15.974 25.9106C14.7516 25.1986 13.7394 24.1759 13.04 22.9463C14.4096 22.8041 15.7351 22.3804 16.9333 21.7017C18.1314 21.023 19.1763 20.104 20.0024 19.0023C20.8284 17.9006 21.4179 16.6401 21.7337 15.2998C22.0495 13.9595 22.0848 12.5684 21.8375 11.2137C23.5916 11.6277 25.1545 12.6218 26.273 14.035C27.3915 15.4482 28 17.1977 28 19V27Z"
            fill="currentColor"
          />
        </svg>
      ),
      path: '/agents',
      hide: true,
    },
    {
      name: t('analytics', 'Analytics'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="19"
          viewBox="0 0 20 19"
          fill="none"
        >
          <path
            d="M18.5 18H3.01111C2.48217 18 2.2177 18 2.01568 17.8971C1.83797 17.8065 1.69349 17.662 1.60294 17.4843C1.5 17.2823 1.5 17.0178 1.5 16.4889V1M18.5 4.77778L13.3676 9.91019C13.1806 10.0972 13.0871 10.1907 12.9793 10.2257C12.8844 10.2565 12.7823 10.2565 12.6874 10.2257C12.5796 10.1907 12.4861 10.0972 12.2991 9.91019L10.5343 8.14537C10.3472 7.95836 10.2537 7.86486 10.1459 7.82982C10.0511 7.79901 9.94892 7.79901 9.85407 7.82982C9.74625 7.86486 9.65275 7.95836 9.46574 8.14537L5.27778 12.3333M18.5 4.77778H14.7222M18.5 4.77778V8.55556"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/analytics',
    },
    {
      name: t('media', 'Media'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="21"
          viewBox="0 0 20 21"
          fill="none"
        >
          <path
            d="M7.50008 3L6.66675 7.16667M13.3334 3L12.5001 7.16667M18.3334 7.16667H1.66675M5.66675 18H14.3334C15.7335 18 16.4336 18 16.9684 17.7275C17.4388 17.4878 17.8212 17.1054 18.0609 16.635C18.3334 16.1002 18.3334 15.4001 18.3334 14V7C18.3334 5.59987 18.3334 4.8998 18.0609 4.36502C17.8212 3.89462 17.4388 3.51217 16.9684 3.27248C16.4336 3 15.7335 3 14.3334 3H5.66675C4.26662 3 3.56655 3 3.03177 3.27248C2.56137 3.51217 2.17892 3.89462 1.93923 4.36502C1.66675 4.8998 1.66675 5.59987 1.66675 7V14C1.66675 15.4001 1.66675 16.1002 1.93923 16.635C2.17892 17.1054 2.56137 17.4878 3.03177 17.7275C3.56655 18 4.26662 18 5.66675 18Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/media',
    },
    {
      // AI captions come with a paid plan, like Sets, Signatures and AI prompts
      name: t('ai_captions_menu', 'Captions'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="19"
          viewBox="0 0 20 19"
          fill="none"
        >
          <rect
            x="1.5"
            y="1.5"
            width="17"
            height="16"
            rx="3.5"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M5 7.5H8.5M11 7.5H15M5 11.5H10M12.5 11.5H15"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/ai-captions',
      hide: user?.tier?.current === 'FREE',
    },
    {
      // The content plan is free for every plan
      name: t('content_plan_menu', 'Plan'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="21"
          viewBox="0 0 20 21"
          fill="none"
        >
          <path
            d="M18.3334 8.5H1.66675M13.3334 1.5V4.5M6.66675 1.5V4.5M6.33341 19.5H13.6667C15.0668 19.5 15.7669 19.5 16.3017 19.2275C16.7721 18.9878 17.1545 18.6054 17.3942 18.135C17.6667 17.6002 17.6667 16.9001 17.6667 15.5V8.5C17.6667 7.09987 17.6667 6.3998 17.3942 5.86502C17.1545 5.39462 16.7721 5.01217 16.3017 4.77248C15.7669 4.5 15.0668 4.5 13.6667 4.5H6.33341C4.93328 4.5 4.23322 4.5 3.69844 4.77248C3.22803 5.01217 2.84558 5.39462 2.60589 5.86502C2.33341 6.3998 2.33341 7.09987 2.33341 8.5V15.5C2.33341 16.9001 2.33341 17.6002 2.60589 18.135C2.84558 18.6054 3.22803 18.9878 3.69844 19.2275C4.23322 19.5 4.93328 19.5 6.33341 19.5Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M6.5 12.5H8.5M11.5 12.5H13.5M6.5 15.5H8.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/plan',
    },
    {
      name: t('plugs', 'Plugs'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="19"
          viewBox="0 0 18 19"
          fill="none"
        >
          <path
            d="M11.6711 6.21205C11.3397 5.88068 11.174 5.715 11.1119 5.52395C11.0573 5.35589 11.0573 5.17486 11.1119 5.00681C11.174 4.81575 11.3397 4.65007 11.6711 4.3187L14.0461 1.94369C13.4158 1.65867 12.7162 1.5 11.9795 1.5C9.20677 1.5 6.95901 3.74776 6.95901 6.5205C6.95901 6.93138 7.00837 7.33073 7.10148 7.71294C7.20119 8.12224 7.25104 8.32689 7.24219 8.45618C7.23292 8.59154 7.21274 8.66355 7.15032 8.78401C7.0907 8.89907 6.97646 9.0133 6.748 9.24177L1.52013 14.4696C0.826947 15.1628 0.826948 16.2867 1.52013 16.9799C2.21332 17.6731 3.3372 17.6731 4.03039 16.9799L9.25825 11.752C9.48672 11.5236 9.60095 11.4093 9.71601 11.3497C9.83647 11.2873 9.90848 11.2671 10.0438 11.2578C10.1731 11.249 10.3778 11.2988 10.7871 11.3985C11.1693 11.4916 11.5686 11.541 11.9795 11.541C14.7523 11.541 17 9.29325 17 6.5205C17 5.78382 16.8413 5.0842 16.5563 4.45394L14.1813 6.82895C13.8499 7.16032 13.6843 7.326 13.4932 7.38808C13.3252 7.44269 13.1441 7.44269 12.9761 7.38808C12.785 7.326 12.6193 7.16032 12.288 6.82895L11.6711 6.21205Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/plugs',
      hide: true,
    },
    {
      name: t('integrations', 'Integrations'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="19"
          viewBox="0 0 20 19"
          fill="none"
        >
          <path
            d="M6.175 3.125C6.175 1.9514 7.1264 1 8.3 1C9.47361 1 10.425 1.9514 10.425 3.125V4.4H11.275C12.4632 4.4 13.0572 4.4 13.5258 4.59411C14.1507 4.85292 14.6471 5.34934 14.9059 5.97416C15.1 6.44277 15.1 7.03685 15.1 8.225H16.375C17.5486 8.225 18.5 9.1764 18.5 10.35C18.5 11.5236 17.5486 12.475 16.375 12.475H15.1V13.92C15.1 15.3481 15.1 16.0622 14.8221 16.6077C14.5776 17.0875 14.1875 17.4776 13.7077 17.7221C13.1622 18 12.4481 18 11.02 18H10.425V16.5125C10.425 15.4563 9.56874 14.6 8.5125 14.6C7.45626 14.6 6.6 15.4563 6.6 16.5125V18H5.58C4.15187 18 3.4378 18 2.89232 17.7221C2.41251 17.4776 2.02241 17.0875 1.77793 16.6077C1.5 16.0622 1.5 15.3481 1.5 13.92V12.475H2.775C3.94861 12.475 4.9 11.5236 4.9 10.35C4.9 9.1764 3.94861 8.225 2.775 8.225H1.5C1.5 7.03685 1.5 6.44277 1.69411 5.97416C1.95292 5.34934 2.44934 4.85292 3.07416 4.59411C3.54277 4.4 4.13685 4.4 5.325 4.4H6.175V3.125Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/third-party',
      hide: true,
    },
  ] satisfies MenuItemInterface[] as MenuItemInterface[];

  const secondMenu = [
    {
      name: t('UGC', 'UGC'),
      icon: (
        <svg
          fill="#c52e2e"
          height="30"
          width="20"
          version="1.1"
          id="Layer_1"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 408.333 408.333"
        >
          <g id="SVGRepo_bgCarrier" strokeWidth="0" />
          <g
            id="SVGRepo_tracerCarrier"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          <g id="SVGRepo_iconCarrier">
            <g id="XMLID_230_">
              <g>
                <path d="M311.056,164.871c41.82-8.912,73.109-49.495,73.109-84.871c0-70-40-80-40-80c0,71.666-19.216,85.621-20,86.666V30 c-50,10-50,96.666-50,116.667c0,7.415-5.414,13.575-12.494,14.773c-5.775-44.153-20.583-71.803-33.729-88.309 c5.77-6.311,12.488-17.252,15.099-35.229c6.586-3.272,11.124-10.049,11.124-17.902c0-11.045-8.955-20-20-20 c-11.046,0-20,8.955-20,20c0,6.912,3.506,13.003,8.837,16.596c-1.916,11.42-5.84,18.233-8.98,22.042 c-5.889-4.981-9.856-6.971-9.856-6.971s-3.968,1.99-9.856,6.971c-3.141-3.809-7.064-10.622-8.98-22.042 c5.33-3.593,8.837-9.685,8.837-16.596c0-11.045-8.955-20-20-20c-11.046,0-20,8.955-20,20c0,7.854,4.537,14.63,11.124,17.902 c2.61,17.977,9.329,28.917,15.099,35.229c-13.146,16.506-27.953,44.156-33.729,88.309c-7.08-1.198-12.494-7.358-12.494-14.773 c0-20,0-106.667-50-116.667v56.666c-0.784-1.045-20-15-20-86.666c0,0-40,10-40,80c0,35.377,31.289,75.96,73.109,84.871 c7.002,19.898,25.135,34.588,46.893,36.558c0,0.08-0.002,0.157-0.002,0.237v15h-21c-13.785,0-25-11.215-25-25h-20 c0,24.813,20.187,45,45,45h21v15h-21c-24.813,0-45,20.187-45,45h20c0-13.785,11.215-25,25-25h21 c0,8.095,3.213,15.436,8.425,20.833c-5.212,5.397-8.425,12.737-8.425,20.833c0,10.41,5.304,19.578,13.355,24.958L134.166,385 c0,0,19.213,23.333,70,23.333c50.787,0,70-23.333,70-23.333l-23.354-46.709c8.051-5.38,13.354-14.548,13.354-24.958 c0-8.096-3.213-15.436-8.425-20.833c5.212-5.397,8.425-12.738,8.425-20.833h21c13.785,0,25,11.215,25,25h20 c0-24.813-20.186-45-45-45h-21v-15h21c24.814,0,45-20.187,45-45h-20c0,13.785-11.215,25-25,25h-21v-15 c0-0.08-0.002-0.158-0.002-0.237C285.923,199.459,304.054,184.77,311.056,164.871z" />
              </g>
            </g>
          </g>
        </svg>
      ),
      path: '#',
      role: ['ADMIN', 'SUPERADMIN', 'USER'],
      requireBilling: true,
      onClick: handleAgentMediaClick,
      hide: true,
    },
    {
      name: t('billing', 'Billing'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="21"
          viewBox="0 0 20 21"
          fill="none"
        >
          <path
            d="M7.08341 12.7225C7.08341 13.7964 7.95397 14.667 9.02786 14.667H10.8334C11.984 14.667 12.9167 13.7343 12.9167 12.5837C12.9167 11.4331 11.984 10.5003 10.8334 10.5003H9.16675C8.01615 10.5003 7.08341 9.56759 7.08341 8.41699C7.08341 7.2664 8.01615 6.33366 9.16675 6.33366H10.9723C12.0462 6.33366 12.9167 7.20422 12.9167 8.2781M10.0001 5.08366V6.33366M10.0001 14.667V15.917M18.3334 10.5003C18.3334 15.1027 14.6025 18.8337 10.0001 18.8337C5.39771 18.8337 1.66675 15.1027 1.66675 10.5003C1.66675 5.89795 5.39771 2.16699 10.0001 2.16699C14.6025 2.16699 18.3334 5.89795 18.3334 10.5003Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/billing',
      role: ['ADMIN', 'SUPERADMIN'],
      requireBilling: true,
    },
    {
      name: t('settings', 'Settings'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="21"
          viewBox="0 0 20 21"
          fill="none"
        >
          <path
            d="M7.82912 16.6429L8.31616 17.7383C8.46094 18.0644 8.69722 18.3414 8.99635 18.5358C9.29547 18.7303 9.64458 18.8337 10.0013 18.8337C10.3581 18.8337 10.7072 18.7303 11.0063 18.5358C11.3055 18.3414 11.5417 18.0644 11.6865 17.7383L12.1736 16.6429C12.3469 16.2542 12.6386 15.9302 13.0069 15.717C13.3776 15.5032 13.8063 15.4121 14.2319 15.4568L15.4236 15.5837C15.7783 15.6212 16.1363 15.555 16.4541 15.3931C16.772 15.2312 17.0361 14.9806 17.2143 14.6716C17.3928 14.3628 17.4778 14.0089 17.4591 13.6527C17.4403 13.2966 17.3186 12.9535 17.1087 12.6651L16.4032 11.6957C16.152 11.3479 16.0177 10.9293 16.0199 10.5003C16.0198 10.0725 16.1553 9.65562 16.4069 9.30959L17.1125 8.34014C17.3223 8.05179 17.444 7.70872 17.4628 7.35255C17.4815 6.99639 17.3965 6.64244 17.218 6.33366C17.0398 6.02469 16.7757 5.77407 16.4578 5.61218C16.14 5.4503 15.782 5.3841 15.4273 5.42162L14.2356 5.54847C13.81 5.59317 13.3813 5.50209 13.0106 5.28829C12.6415 5.07387 12.3498 4.74812 12.1773 4.35773L11.6865 3.26236C11.5417 2.9363 11.3055 2.65925 11.0063 2.46482C10.7072 2.27039 10.3581 2.16693 10.0013 2.16699C9.64458 2.16693 9.29547 2.27039 8.99635 2.46482C8.69722 2.65925 8.46094 2.9363 8.31616 3.26236L7.82912 4.35773C7.65656 4.74812 7.36485 5.07387 6.99579 5.28829C6.62513 5.50209 6.19634 5.59317 5.77079 5.54847L4.57542 5.42162C4.22069 5.3841 3.8627 5.4503 3.54485 5.61218C3.22699 5.77407 2.96293 6.02469 2.78468 6.33366C2.60619 6.64244 2.52116 6.99639 2.5399 7.35255C2.55864 7.70872 2.68034 8.05179 2.89023 8.34014L3.59579 9.30959C3.8474 9.65562 3.9829 10.0725 3.98282 10.5003C3.9829 10.9282 3.8474 11.345 3.59579 11.6911L2.89023 12.6605C2.68034 12.9489 2.55864 13.2919 2.5399 13.6481C2.52116 14.0043 2.60619 14.3582 2.78468 14.667C2.96311 14.9758 3.2272 15.2263 3.54501 15.3882C3.86282 15.55 4.22072 15.6163 4.57542 15.579L5.76708 15.4522C6.19264 15.4075 6.62143 15.4986 6.99208 15.7124C7.36252 15.9262 7.65559 16.252 7.82912 16.6429Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.99985 13.0003C11.3806 13.0003 12.4999 11.881 12.4999 10.5003C12.4999 9.11961 11.3806 8.00033 9.99985 8.00033C8.61914 8.00033 7.49985 9.11961 7.49985 10.5003C7.49985 11.881 8.61914 13.0003 9.99985 13.0003Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/settings',
      role: ['ADMIN', 'USER', 'SUPERADMIN'],
    },
    {
      name: t('super_admin', 'Super Admin'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="21"
          viewBox="0 0 20 21"
          fill="none"
        >
          <path
            d="M10 2.16699L3.33325 5.08366V9.66699C3.33325 13.8337 6.16659 17.0837 10 18.8337C13.8333 17.0837 16.6666 13.8337 16.6666 9.66699V5.08366L10 2.16699Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/super-admin',
      role: ['ADMIN', 'USER', 'SUPERADMIN'],
      // only a super admin sees the link; the proxy closes the URL to everyone else
      hide: !user?.isSuperAdmin,
    },
  ] satisfies MenuItemInterface[] as MenuItemInterface[];

  return {
    all: [...firstMenu, ...secondMenu],
    firstMenu,
    secondMenu,
  };
};

// Renders the desktop left navigation menu.
export const TopMenu: FC = () => {
  const user = useUser();
  const { firstMenu, secondMenu } = useMenuItem();
  const { isGeneral, billingEnabled } = useVariables();
  return (
    <>
      <div className="flex flex-1 flex-col minCustom:gap-[16px] blurMe">
        {
          // @ts-ignore
          user?.orgId &&
            // @ts-ignore
            (user.tier !== 'FREE' || !isGeneral || !billingEnabled) &&
            firstMenu
              .filter((f) => {
                if (f.hide) {
                  return false;
                }
                if (f.requireBilling && !billingEnabled) {
                  return false;
                }
                if (f.name === 'Billing' && user?.isLifetime) {
                  return false;
                }
                if (f.role) {
                  return f.role.includes(user?.role!);
                }
                return true;
              })
              .map((item, index) => (
                <MenuItem
                  path={item.path}
                  label={item.name}
                  icon={item.icon}
                  key={item.name}
                  onClick={item.onClick}
                />
              ))
        }
      </div>
      <div className="flex flex-col minCustom:gap-[20px] custom:gap-[8px] blurMe">
        {secondMenu
          .filter((f) => {
            if (f.hide) {
              return false;
            }
            if (f.requireBilling && !billingEnabled) {
              return false;
            }
            if (f.name === 'Billing' && user?.isLifetime) {
              return false;
            }
            if (f.role) {
              return f.role.includes(user?.role!);
            }
            return true;
          })
          .map((item, index) => (
            <MenuItem
              path={item.path}
              label={item.name}
              icon={item.icon}
              key={item.name}
              onClick={item.onClick}
            />
          ))}
      </div>
    </>
  );
};

export interface MobileNavigationProps {
  isOpen?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  onBrandClick?: () => void;
}

// Renders the mobile bottom navigation bar and Android-style left slider drawer.
export const MobileNavigation: FC<MobileNavigationProps> = ({
  isOpen: controlledIsOpen,
  onOpen: controlledOnOpen,
  onClose: controlledOnClose,
  onBrandClick,
}) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen =
    controlledIsOpen !== undefined ? controlledIsOpen : internalOpen;
  const onOpen = controlledOnOpen || (() => setInternalOpen(true));
  const onClose = controlledOnClose || (() => setInternalOpen(false));

  const user = useUser();
  const { firstMenu, secondMenu } = useMenuItem();
  const { isGeneral, billingEnabled } = useVariables();
  const currentPath = useWorkspacePathname();
  const t = useT();
  const fetch = useFetch();
  const modals = useModals();

  // Close drawer on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [isOpen]);

  // Filters items matching user roles and billing permissions
  const isItemVisible = useCallback(
    (item: MenuItemInterface) => {
      if (item.hide) return false;
      if (item.requireBilling && !billingEnabled) return false;
      if (item.name === 'Billing' && user?.isLifetime) return false;
      if (item.role) return fRole(item.role, user?.role);
      return true;
    },
    [billingEnabled, user]
  );

  // Checks whether the user role matches any allowed role.
  function fRole(roles?: string[], userRole?: string) {
    if (!roles || !userRole) return false;
    return roles.includes(userRole);
  }

  // Opens the post creation editor modal
  const handleCreatePost = useCallback(async () => {
    try {
      const [slotRes, intRes] = await Promise.all([
        fetch('/posts/find-slot'),
        fetch('/integrations/list'),
      ]);
      const { date } = await slotRes.json();
      const { integrations = [] } = await intRes.json();

      let sets: any[] = [];
      try {
        const setsRes = await fetch('/sets');
        sets = await setsRes.json();
      } catch (e) {}

      let selectedSet: any = undefined;
      if (sets && sets.length > 0) {
        selectedSet = await new Promise((resolve) => {
          modals.openModal({
            title: t('select_set', 'Select a Set'),
            closeOnClickOutside: true,
            closeOnEscape: true,
            withCloseButton: false,
            onClose: () => resolve('exit'),
            classNames: {
              modal: 'text-textColor',
            },
            children: (
              <SetSelectionModal
                sets={sets}
                onSelect={(set) => {
                  resolve(set);
                  modals.closeAll();
                }}
                onContinueWithoutSet={() => {
                  resolve(undefined);
                  modals.closeAll();
                }}
              />
            ),
          });
        });
      }

      if (selectedSet === 'exit') return;

      modals.openModal({
        id: 'add-edit-modal',
        closeOnClickOutside: false,
        removeLayout: true,
        closeOnEscape: false,
        withCloseButton: false,
        askClose: true,
        fullScreen: true,
        classNames: {
          modal: 'w-[100%] max-w-[1400px] text-textColor',
        },
        children: (
          <AddEditModal
            allIntegrations={integrations.map((p: any) => ({ ...p }))}
            integrations={integrations.map((p: any) => ({ ...p }))}
            {...(selectedSet?.content
              ? { set: JSON.parse(selectedSet.content) }
              : {})}
            reopenModal={handleCreatePost}
            mutate={() => {}}
            date={date ? dayjs.utc(date).local() : dayjs()}
          />
        ),
        size: '80%',
        title: '',
      });
    } catch (err) {
      console.error('Failed to open post editor', err);
    }
  }, [fetch, modals, t]);

  const calendarItem = firstMenu[0];
  const mediaItem = firstMenu.find((item) => item.path === '/media');
  const analyticsItem = firstMenu.find((item) => item.path === '/analytics');

  const isLaunchesActive =
    currentPath === '/launches' || currentPath.startsWith('/launches');
  const isMediaActive =
    currentPath === '/media' || currentPath.startsWith('/media');
  const isAnalyticsActive =
    currentPath === '/analytics' || currentPath.startsWith('/analytics');
  const isMoreActive =
    isOpen ||
    (!isLaunchesActive && !isMediaActive && !isAnalyticsActive);

  const secondaryItems = [
    ...firstMenu.filter(
      (item) => !['/launches', '/media', '/analytics'].includes(item.path)
    ),
    ...secondMenu,
  ].filter(isItemVisible);

  return (
    <>
      {/* Mobile Bottom Navigation Bar */}
      <nav
        aria-label="Mobile Navigation"
        className="fixed bottom-0 left-0 right-0 z-50 bg-newBgColorInner border-t border-newBorder h-[60px] flex items-center justify-around px-[8px] md:hidden"
      >
        {/* Launches / Calendar */}
        <WorkspaceLink
          href="/launches"
          className={clsx(
            'flex-1 flex flex-col items-center justify-center py-[6px] gap-[2px] transition-colors',
            isLaunchesActive
              ? 'text-textItemFocused font-[600]'
              : 'text-textItemBlur hover:text-textItemFocused'
          )}
        >
          <div className="scale-90">{calendarItem?.icon}</div>
          <span className="text-[10px] truncate max-w-[64px]">
            {calendarItem?.name || t('launches', 'Launches')}
          </span>
        </WorkspaceLink>

        {/* Media */}
        <WorkspaceLink
          href="/media"
          className={clsx(
            'flex-1 flex flex-col items-center justify-center py-[6px] gap-[2px] transition-colors',
            isMediaActive
              ? 'text-textItemFocused font-[600]'
              : 'text-textItemBlur hover:text-textItemFocused'
          )}
        >
          <div className="scale-90">{mediaItem?.icon}</div>
          <span className="text-[10px] truncate max-w-[64px]">
            {mediaItem?.name || t('media', 'Media')}
          </span>
        </WorkspaceLink>

        {/* New Post (+) trigger */}
        <div className="flex-1 flex items-center justify-center">
          <button
            type="button"
            onClick={handleCreatePost}
            className="flex flex-col items-center justify-center -mt-[14px] group outline-none"
            aria-label={t('create_new_post', 'Create Post')}
          >
            <div className="w-[42px] h-[42px] rounded-full bg-btnPrimary text-white flex items-center justify-center shadow-lg group-active:scale-95 transition-transform">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <span className="text-[10px] font-[600] text-textItemBlur group-hover:text-newTextColor mt-[2px]">
              {t('create_post_short', 'Post')}
            </span>
          </button>
        </div>

        {/* Analytics */}
        <WorkspaceLink
          href="/analytics"
          className={clsx(
            'flex-1 flex flex-col items-center justify-center py-[6px] gap-[2px] transition-colors',
            isAnalyticsActive
              ? 'text-textItemFocused font-[600]'
              : 'text-textItemBlur hover:text-textItemFocused'
          )}
        >
          <div className="scale-90">{analyticsItem?.icon}</div>
          <span className="text-[10px] truncate max-w-[64px]">
            {analyticsItem?.name || t('analytics', 'Analytics')}
          </span>
        </WorkspaceLink>

        {/* More Drawer Trigger */}
        <button
          type="button"
          onClick={isOpen ? onClose : onOpen}
          className={clsx(
            'flex-1 flex flex-col items-center justify-center py-[6px] gap-[2px] transition-colors outline-none',
            isMoreActive
              ? 'text-textItemFocused font-[600]'
              : 'text-textItemBlur hover:text-textItemFocused'
          )}
          aria-label={t('more', 'More')}
        >
          <div className="scale-90">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </div>
          <span className="text-[10px] truncate max-w-[64px]">
            {t('more', 'More')}
          </span>
        </button>
      </nav>

      {/* Mobile Android-Style Left Slider Drawer */}
      <div
        className={clsx(
          'fixed inset-0 z-50 md:hidden transition-all duration-200',
          isOpen
            ? 'pointer-events-auto visible'
            : 'pointer-events-none invisible delay-200'
        )}
        aria-hidden={!isOpen}
      >
        {/* Backdrop */}
        <div
          onClick={onClose}
          className={clsx(
            'fixed inset-0 z-40 bg-black/60 backdrop-blur-xs transition-opacity duration-200',
            isOpen ? 'opacity-100' : 'opacity-0'
          )}
          aria-hidden="true"
        />

        {/* Drawer Panel */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('menu', 'Menu')}
          className={clsx(
            'fixed inset-y-0 left-0 z-50 w-[300px] max-w-[85vw] bg-newBgColorInner shadow-2xl flex flex-col will-change-transform transition-transform duration-200 ease-out border-r border-newBorder',
            isOpen ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-[20px] py-[16px] border-b border-newBorder shrink-0">
            <div className="flex items-center gap-[10px] min-w-0">
              <img
                src={PRODUCT_LOGO_PATH}
                alt={PRODUCT_NAME}
                className="w-[32px] h-[32px] rounded-[8px] object-contain shrink-0"
              />
              <span className="text-[16px] font-[600] text-newTextColor truncate">
                {PRODUCT_NAME}
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-[32px] h-[32px] rounded-full flex items-center justify-center text-textItemBlur hover:text-newTextColor hover:bg-boxHover transition-colors shrink-0"
              aria-label={t('close', 'Close')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-[16px] flex flex-col gap-[16px] pb-[32px]">
            {/* Secondary Controls Card: Streak, Language, Feedback */}
            <div className="flex items-center justify-between p-[12px] bg-newBgLineColor/40 rounded-[12px] border border-newBorder/50 shrink-0">
              <div className="flex items-center gap-[12px]">
                <StreakComponent />
                <div className="w-[1px] h-[18px] bg-blockSeparator" />
                <div className="flex items-center gap-[6px]">
                  <LanguageComponent />
                  <span className="text-[12px] text-textItemBlur">
                    {t('language', 'Language')}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-[6px]">
                <AttachToFeedbackIcon />
                <span className="text-[12px] text-textItemBlur">
                  {t('feedback', 'Feedback')}
                </span>
              </div>
            </div>

            {/* Brand Indicator */}
            <div className="flex items-center justify-between px-[4px] shrink-0">
              <div className="text-[12px] font-[600] text-textItemBlur uppercase tracking-wider">
                {t('brand', 'Brand')}
              </div>
              <div className="max-w-[180px] truncate [&>div:last-child]:hidden">
                <BrandBadge
                  onClick={() => {
                    onClose();
                    onBrandClick?.();
                  }}
                />
              </div>
            </div>

            {/* Secondary Navigation Items */}
            <div className="flex flex-col gap-[4px]">
              <div className="text-[12px] font-[600] text-textItemBlur uppercase tracking-wider px-[4px] mb-[4px]">
                {t('navigation', 'Navigation')}
              </div>
              {secondaryItems.map((item) => {
                const isActive =
                  item.path !== '#' &&
                  (currentPath === item.path ||
                    currentPath.startsWith(item.path + '/'));
                const content = (
                  <>
                    <div className="w-[24px] h-[24px] flex items-center justify-center shrink-0">
                      {item.icon}
                    </div>
                    <span className="flex-1 text-[14px] font-[500] text-start truncate">
                      {item.name}
                    </span>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-textItemBlur opacity-50 shrink-0"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </>
                );

                const itemClassName = clsx(
                  'flex items-center gap-[12px] w-full px-[14px] py-[12px] rounded-[12px] transition-colors',
                  isActive
                    ? 'bg-boxFocused text-textItemFocused font-[600]'
                    : 'text-textItemBlur hover:text-textItemFocused hover:bg-boxHover'
                );

                if (item.onClick || item.path === '#') {
                  return (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => {
                        onClose();
                        item.onClick?.();
                      }}
                      className={itemClassName}
                    >
                      {content}
                    </button>
                  );
                }

                return (
                  <WorkspaceLink
                    key={item.name}
                    href={item.path}
                    onClick={onClose}
                    className={itemClassName}
                  >
                    {content}
                  </WorkspaceLink>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
