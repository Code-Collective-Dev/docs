import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightThemeNova from 'starlight-theme-nova';
import starlightSidebarTopics from 'starlight-sidebar-topics';
import starlightImageZoom from 'starlight-image-zoom';
import { topics } from './src/topics.mjs';

function group(label, directory, collapsed = false) {
  return { label, collapsed, items: [{ autogenerate: { directory: 'tandem/' + directory } }] };
}

const TOPIC_ITEMS = [
  [group('Getting started', 'getting-started'), group('Theme settings', 'theme-settings'), group('Header and footer', 'global')],
  [group('Sections', 'sections')],
  [group('Product page', 'product-page'), group('Collections and search', 'collections'), group('Pages and templates', 'pages')],
  [group('Wholesale and B2B', 'wholesale')],
  [group('Guides', 'guides'), { label: 'Help', items: ['tandem/faq', 'tandem/changelog', 'tandem/support'] }],
];


export default defineConfig({
  site: 'https://docs.codecollective.io',
  integrations: [
    starlight({
      title: 'Code Collective',
      description: 'Help centers for Code Collective Shopify themes and apps.',
      logo: { src: './src/assets/cc-mark.svg' },
      favicon: '/favicon.svg',
      customCss: ['@fontsource-variable/inter', './src/styles/custom.css'],
      lastUpdated: true,
      pagination: true,
      social: [{ icon: 'email', label: 'Contact support', href: 'https://codecollective.io/themes/tandem/support' }],
      head: [{ tag: 'meta', attrs: { name: 'theme-color', content: '#fbfaf8' } }],
      components: { Header: './src/components/Header.astro', PageTitle: './src/components/PageTitle.astro' },
      plugins: [
        starlightThemeNova(),
        starlightImageZoom(),
        starlightSidebarTopics(topics.map((t, i) => ({ label: t.label, link: t.link, icon: t.icon, items: TOPIC_ITEMS[i] })), { exclude: ['/', '/tandem/'] }),
      ],
    }),
  ],
});
