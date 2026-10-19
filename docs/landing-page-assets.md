# Qevra landing page assets and editing

The landing page is `/`. Existing business, staff, auth and customer routes remain unchanged. Preview from the repository root with `npm run dev:web`, then open http://localhost:5173/. The existing dashboard buttons link to `/app` and preserve the existing authentication flow.

## Optional photos

Place licensed/owned photos in **apps/web/src/assets/landing/**. This source-assets convention lets Vite discover actual files at build time, avoiding requests to nonexistent public URLs. No photo is required: original inline SVG room/customer illustrations fill all empty slots. An image load failure also returns to the illustration. The reference image is not embedded and no remote image hotlinks are used.

Use these exact filenames (WebP preferred):

| Filename | Recommended size / ratio | Subject |
| --- | --- | --- |
| hero-context.webp | 1200 × 1200, square | Calm modern business reception; background behind the React dashboard |
| queue-congestion.webp | 1200 × 750, 8:5 | Busy waiting room or service queue |
| unclear-wait.webp | 1200 × 750, 8:5 | Customer checking their phone while waiting |
| staff-coordination.webp | 1200 × 750, 8:5 | Staff coordinating front-desk service |
| solution.webp | 1200 × 1200, square | Relaxed customer using a phone in a welcoming service space |
| industry-salon.webp | 1200 × 620, approximately 2:1 | Salon or barbershop interior |
| industry-clinic.webp | 1200 × 620 | Clinic reception without identifiable medical information |
| industry-restaurant.webp | 1200 × 620 | Restaurant counter / welcoming dining space |
| industry-retail.webp | 1200 × 620 | Retail customer service counter |
| industry-institution.webp | 1200 × 620 | Campus or public-service reception |

JPG, PNG and AVIF are also supported with the same basename. Use only one file per slot. No JSX editing is needed; restart Vite/rebuild after adding assets. Keep subjects near the center because responsive layouts crop with object-fit: cover. Aim for under 200 KB per image, strip metadata, and obtain any necessary subject consent. Images are lazy-loaded, asynchronously decoded and placed in fixed-ratio containers. Contact/photos configuration is in `apps/web/src/features/landing/config.ts`.

## Real contact information

Edit `landingContact` at the top of **apps/web/src/features/landing/config.ts**:

- `whatsapp`: real international number with `+` and digits only.
- `email`: real public contact email.
- `linkedin`: full HTTPS LinkedIn `/in/...` or `/company/...` URL.

All fields intentionally start empty. Empty/invalid details display “Segera tersedia” as noninteractive cards. No fake number/email or broken contact link is generated. A product-preview link is available while contact channels are unconfigured. Configured links open the relevant real channel.

## Content and interaction

- `landing-page.tsx`: page sections, icons, original illustrations, dashboard/public/staff previews, eight features, FAQ, concept pricing.
- `landing.css`: styles scoped to `.landing`, responsive layouts, focus states and reduced-motion behavior. Existing application tokens/styles are preserved.
- `app/router.tsx`: only the `/` landing route changes; other routes retain their layouts. Existing active customer TicketShortcut remains on the home page.
- Product mockup numbers are explicitly illustrative, not live metrics. Preview controls are noninteractive illustrations; the surrounding tabs and dashboard links work.
- Pricing and add-ons are clearly concept simulations, with contact anchors and no checkout. WhatsApp copy explains Sandbox enrollment and the 24-hour conversation window.

## Verification

`npm run typecheck -w @qevra/web` and `npm run lint` check code. `npm run build -w @qevra/web` builds with your configured public frontend environment. Do not add private keys to Vite.

For the browser check, run a local frontend preview and use:

```powershell
$env:LANDING_PREVIEW_URL = 'http://localhost:5173'
node scripts/verify-landing.mjs
```

This uses installed Chrome through Playwright, tests tabs/keyboard/FAQ/mobile navigation, checks anchors and horizontal overflow at 320/390/768px, and saves desktop/mobile screenshots under ignored `.runtime/landing/`. Use an environment-free local preview for checks that must not access configured Supabase. The script itself never loads .env or writes database records.
