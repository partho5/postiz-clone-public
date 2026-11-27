// Legal pages: the three links to the public Terms, Privacy and data-deletion pages.

const LEGAL_PAGES = [
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/data-deletion', label: 'Data deletion' },
];

// Renders a link to each public legal page; plain anchors, so the pages open outside any workspace.
export const LegalLinks = () => {
  return (
    <nav className="flex items-center gap-[12px]" aria-label="Legal">
      {LEGAL_PAGES.map((page) => (
        <a
          key={page.href}
          href={page.href}
          className="text-[12px] text-textItemBlur hover:underline"
        >
          {page.label}
        </a>
      ))}
    </nav>
  );
};
