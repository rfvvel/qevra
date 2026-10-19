// Add real contact details here. Empty/invalid values never become clickable links.
export const landingContact = { whatsapp: '', email: '', linkedin: '' };
export function contactLinks(contact = landingContact) {
  return [
    { label: 'WhatsApp', icon: 'message', href: /^\+[1-9]\d{7,14}$/.test(contact.whatsapp) ? 'https://wa.me/' + contact.whatsapp.slice(1) : null },
    { label: 'Email', icon: 'mail', href: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email) ? 'mailto:' + contact.email : null },
    { label: 'LinkedIn', icon: 'link', href: /^https:\/\/(www\.)?linkedin\.com\/(in|company)\/[a-zA-Z0-9_-]+\/?$/.test(contact.linkedin) ? contact.linkedin : null },
  ];
}
// Vite discovers real local files only; missing slots render SVG, not broken URLs.
const photos = import.meta.glob('../../assets/landing/*.{webp,jpg,png,avif}', { eager: true, query: '?url', import: 'default' }) as Record<string,string>;
export function landingPhoto(slot: string) {
  return Object.entries(photos).find(([path]) => path.split('/').pop()?.split('.')[0] === slot)?.[1];
}
