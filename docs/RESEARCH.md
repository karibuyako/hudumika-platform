# Research — Meituan & DoorDash Public Web Analysis

Research performed August 2026 for the HUDumika public web rebuild.
Findings verified via live fetches of Meituan pages and a Wayback Machine snapshot of doordash.com (Jan 2026; the live site blocks bots with 403).

---

## 1. Meituan — waimai.meituan.com (consumer web) + redirect "doors"

### 1.1 Persistent top nav (present on every page)

- 首页 (Home — the ordering homepage)
- 入驻加盟 (Merchant Join / Onboarding)
- 技术合作中心 (Tech Cooperation Center → developer.meituan.com)
- 社会责任 (CSR)
- 营养查询 (Nutrition lookup → health.waimai.meituan.com)
- 下载手机版 (Download mobile app → /mobile/download/default)

### 1.2 Help sub-nav

- 找客服 (Contact support)
- 常见问题 (FAQ — grouped: Online Payment · Promotions · Orders · Other)
- 人才招聘 (Careers)
- 配送合作 (Delivery partner)
- 诚信举报 (Integrity reporting)

### 1.3 Redirect "doors" (endpoints the site points to)

| Link label      | URL                            | Content |
| --------------- | ------------------------------ | ------- |
| Download app    | /mobile/download               | iPhone (App Store) + Android download + QR code for 美团外卖App |
| Merchant join   | i.waimai.meituan.com/cpc/joinin.html | Merchant onboarding (JS-rendered) |
| Merchant center | e.waimai.meituan.com           | Merchant login + PC/mobile client download — **app-gated** |
| Merchant self-onboard | kd.meituan.com            | "Download the latest version to apply for a shop" — **download-gated** |
| Rider recruitment | page.peisong.meituan.com/rider | Two tracks (专送 dedicated / 众包 gig), benefits, insurance, FAQ, signup |
| FAQ             | /help/faq                      | Real grouped Q&A: refunds, 超时赔付 (late-delivery compensation), cancellation rules, payment methods |
| Tech/API        | developer.meituan.com          | Open platform for developers |
| Rules center    | rules-center.meituan.com       | Legal/rules center |
| CSR             | /cpc/csrpc/index.html          | Rider welfare stories + awards |

### 1.4 Homepage (from knowledge + search data)

City-based: category tabs (外卖/生鲜/医药/鲜花/便利/甜点/快送), search, banner carousel, "猜你喜欢" (recommendations), promo-marked restaurant list. Fully JS-rendered SPA (empty `#root` in raw HTML).

### 1.5 Key pattern takeaways

- Web pages exist to **route audiences** + **capture leads** + **force app downloads**
- Merchant onboarding is app/download-gated (web is a lead-capture gate)
- FAQ is grouped by topic with real, detailed answers
- CSR page used as a trust-builder (rider welfare stories)
- Every page carries SEO meta description/keywords

---

## 2. DoorDash — www.doordash.com (verified via Wayback snapshot 2026-01-03)

### 2.1 Homepage structure (top → bottom)

1. **Promo strip**: "$0 DELIVERY FEE ON FIRST ORDER — other fees apply" + Sign In / Sign Up
2. **Nav with audience dropdowns**:
   - *Become a Dasher* → "As a delivery driver, make money and work on your schedule. Sign up in minutes." → Start earning
   - *Become a Merchant* → "Attract new customers and grow sales, starting with **0% commissions for up to 30 days**." → Sign up for DoorDash
   - *Get the app* → "Experience the best your neighborhood has to offer, all in one app"
3. **Hero**: "Everything you crave, delivered." → Find restaurants
4. **DashPass membership block**: $0 delivery fee, 5% back on pickup, free 30 days
5. **Category CTA cards** (each its own marketing block):
   - Groceries — "Grocery delivery, exactly how you want it" → Shop Groceries
   - Convenience — "under an hour" → Shop Now
   - Beauty — "Shop beauty"
   - Flowers — "Send Flowers"
   - Alcohol — 21+ notice → Shop Alcohol
   - Pet supplies → Get Pet Supplies
6. **"Unlocking opportunity for Dashers and businesses"** — dual CTA:
   - Dasher: "Sign up to dash and get paid — Deliver with the #1 Food and Drink App in the U.S."
   - Merchant: "Grow your business with DoorDash — Businesses large and small partner with DoorDash to reach new customers, increase order volume, and drive more sales." → Become a Partner
7. **SEO link farms**: "Popular Categories" (100+ links) + "Get more from your neighborhood" (Top Cities / Top Cuisines / Top Chains)
8. **Footer**:
   - *Get to Know Us*: About Us, Careers, Investors, Company Blog, Engineering Blog, Merchant Blog, Gift Cards, Promotions, **Dasher Central**, LinkedIn, Glassdoor, Accessibility, Newsroom
   - *Let Us Help You*: Account Details, Order History, Help
   - *Doing Business*: DoorDash Merchant, Get Dashers for Deliveries, **Get DoorDash for Business** (B2B), Terms of Service, Privacy, Delivery Locations, Do Not Sell or Share My Personal Information
   - **Locale switcher**: English (US), Español (US), English (CA), Français (CA), English (AU), English (NZ)

### 2.2 Redirect targets (the "doors")

| Door                  | URL                                | Content |
| --------------------- | ---------------------------------- | ------- |
| Merchant portal       | doordash.com/merchant              | Login dashboard: Insights, Sales, Reports, Customers, Marketing, Menu Manager, Store Availability, Financials, Payouts, Integrations, POS, Help |
| Merchant signup       | get.doordash.com                   | Onboarding — 0% commission for 30 days |
| Dasher app gate       | dasherapp.doordash.com/home        | "You must be on your Android or iOS device to download the Dasher app" → App Store / Play Store links only (**app-gated**) |
| Help center           | help.doordash.com                  | **Split by audience**: consumers / dashers / merchants; 24/7 chat + phone |
| B2B                   | business.doordash.com              | Corporate catering, meal plans, invoicing |
| Corporate             | careers / about / investors / newsroom / engineering + merchant blogs | |

### 2.3 Key pattern takeaways

- Conversion-first: promo strip, offer-laden nav dropdowns, membership upsell
- Categories become marketing blocks with CTAs, not plain icons
- Help center split per audience with 24/7 support + phone numbers
- Massive SEO link farms in footer (cities, cuisines, chains)
- Merchant portal marketed via dashboard-module overview (Insights/Reports/Menu/Financials)
- Dasher downloads are app-gated (web = lead capture)

---

## 3. Comparison vs. HUDumika prototype (public-web)

| DoorDash / Meituan feature                     | Ours (prototype)           | Gap → fix in v2 |
| ---------------------------------------------- | -------------------------- | --------------- |
| Promo strip ("$0 fee first order")             | none                       | Add top promo bar |
| Audience dropdowns with offers                 | plain nav links            | Add dropdowns with offers |
| Membership (DashPass)                          | none                       | Add HUDumika+ teaser |
| Category CTA cards                             | icon grid only             | Upgrade to CTA cards |
| Dual audience "opportunity" section            | 3 AudienceCards ✓          | Covered |
| Merchant dashboard modules preview             | thin placeholder           | Add dashboard mock on /merchant |
| App-gated download pages                       | planned per-portal         | Covered |
| Help center split by audience + phone          | single /support planned    | Split into 3 tracks |
| Grouped FAQ                                    | none                       | Add /faq (Meituan model) |
| CSR page (rider welfare)                       | none                       | Add /csr |
| SEO link farms (cities/cuisines)               | none                       | Add modest footer SEO block |
| B2B link (DoorDash for Business)               | none                       | Add Corporate link/teaser |
| Legal/rules center                             | footer stubs               | Add /privacy /terms /cookies |
| Per-page SEO meta                              | single global meta         | Add per-route meta |

---

## 4. Sources

- Live fetches: waimai.meituan.com (nav/footer/FAQ/download page), i.waimai.meituan.com (joinin, csrpc, platform), kd.meituan.com, e.waimai.meituan.com
- Search results: merchant center (e.waimai.meituan.com), rider recruitment (page.peisong.meituan.com/rider), meituan.com corporate hub, merchant portal learning center (merchants.doordash.com), Dasher app overview (help.doordash.com)
- Wayback Machine: www.doordash.com snapshot 2026-01-03 (timestamps 20260103100148), dasherapp.doordash.com/home snapshot 2026-06-08
- Note: doordash.com and help.doordash.com return 403 to bots; the `srsltid` tracking param does not bypass this. waimai.meituan.com homepage is a JS SPA (empty `#root` in raw HTML).
