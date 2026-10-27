<h1 align="center">Fleetbase Customer Portal</h1>

<p align="center">
    An extendable customer workspace for Fleetbase with self-service orders, billing, documents, support, account settings, and dashboard widgets.
</p>

<p align="center">
    <a href="https://github.com/fleetbase/customer-portal/blob/main/LICENSE.md"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg" alt="License"></a>
    <a href="https://www.npmjs.com/package/@fleetbase/customer-portal-engine"><img src="https://img.shields.io/npm/v/@fleetbase/customer-portal-engine.svg" alt="npm package"></a>
    <a href="https://packagist.org/packages/fleetbase/customer-portal-api"><img src="https://img.shields.io/packagist/v/fleetbase/customer-portal-api.svg" alt="Packagist package"></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22-339933.svg" alt="Node.js >= 22">
    <img src="https://img.shields.io/badge/ember-5.4-E04E39.svg" alt="Ember 5.4">
    <img src="https://img.shields.io/badge/php-%5E8.0-777BB4.svg" alt="PHP ^8.0">
</p>

<p align="center">
    <img src="https://www.fleetbase.io/images/screenshots/customer-portal/customer-portal-dashboard.webp" alt="Fleetbase Customer Portal" width="960">
</p>

## Overview

Fleetbase Customer Portal is a first-party Fleetbase extension that gives customers a secure, self-service workspace connected to Fleetbase Console, FleetOps, and Ledger. It ships as an Ember engine for the frontend and a Laravel package for the backend API.

The portal is designed for customer-facing logistics workflows: customers can sign in, track orders, place new orders, view invoices, manage documents, open support tickets, update account preferences, and use dashboard widgets tailored to their account.

## Collection readiness (gated rollout)

Enrolled new standard Transport orders show preparation/readiness and planned
pickup in order details. **Ready for pickup** loads a scoped server preview;
**Confirm parcels are ready** commits readiness. The preview includes pickup
contacts, physical parcel count and timezone. **Keep preparing** changes nothing.
**Withdraw readiness** requires confirmation and is allowed only before planning.
Calendar/content/cutoff changes invalidate confirmation; HTTP 409 is surfaced and
the customer must review again. Repeated successful requests do not create orders
or duplicate readiness history. Failed confirmations do not discard the order.

Collection endpoints are `GET/POST orders/{id}/collection-readiness` in the
authenticated customer namespace. They enforce company/account ownership and
lock the order for mutation. Generic rescheduling and contract edits are blocked
on enrolled orders; planned/collected orders require operations for changes or
cancellation. Existing orders and Returns are unchanged. Enrollment remains
disabled until pickup rounds and depot custody are implemented; this is not a
production activation or Express release.

## Features

- **Customer authentication** - Customer login, two-factor verification, password recovery, customer session loading, and automatic redirects from customer access URLs.
- **Dashboard workspace** - Customer dashboard registration with widgets for active orders, completed orders, unpaid invoices, open support tickets, recent orders, and pending actions.
- **Order management** - Order listing, order details, order creation, route preview, place lookup, payload/entities, custom fields, notes, documents, cancel, reschedule, and file attachments.
- **Quotes and payments** - Preliminary service quote lookup, portal-scoped purchase rates, optional Stripe checkout sessions, payment status checks, and Ledger invoice reconciliation.
- **Billing** - Customer invoice lists, invoice details, and invoice summaries backed by Ledger when it is installed and available.
- **Support** - Customer support tickets backed by FleetOps Issues, including issue creation, summaries, comments, replies, editing, and deletion.
- **Documents and address book** - Customer-visible order documents plus account-scoped place search, lookup, creation, update, and deletion.
- **Account settings** - Account profile data, self-service password change, vendor conversion flows, personnel management, and notification preferences.
- **Admin configuration** - Console settings panel for portal configuration, access URL validation, enabled order configs, enabled service rates, and payment settings.
- **Extension points** - Sidebar and login registries, dashboard/widget registration, virtual routes, and menu integration for extending the portal from other Fleetbase packages.

## Architecture

This repository contains both sides of the extension:

```text
addon/      Ember engine source: routes, templates, components, services, widgets, and extension registration
app/        Re-exports that make addon modules available to the consuming Fleetbase Console app
server/     Laravel package source: routes, controllers, services, providers, notifications, and observers
tests/      Ember/QUnit tests and dummy app support
```

### Frontend package

```bash
@fleetbase/customer-portal-engine
```

The Ember engine mounts at the Fleetbase route configured in `package.json`:

```json
{
    "fleetbase": {
        "route": "customer-portal",
        "mount": "root"
    }
}
```

The engine registers customer portal routes for authentication, dashboard, orders, billing, support, documents, address book, notifications, settings, account management, and virtual extension pages.

### Backend package

```bash
fleetbase/customer-portal-api
```

The Laravel package registers portal APIs under the configurable prefix:

```text
customer-portal/int/v1
```

Backend controllers and services scope data to the authenticated customer account, integrate with FleetOps orders and issues, integrate with Ledger invoices and transactions, and expose portal configuration for Console admins.

### Delivery creation contract

For requests containing `meta.delivery`, both preliminary quotes and order creation validate the same delivery inputs:

- Supply pickup and dropoff together, or at least two waypoints, and at least one named parcel with a current, compatible packaging classification. Invalid or unavailable route stops are rejected rather than removed.
- Route, parcel, and COD fields can be supplied inside `payload` or at the top level. Conflicting duplicate values are rejected. An explicitly invalid workflow never falls back to another workflow.
- Supply a current, account-scoped `service_quote_uuid` (or a purchase rate belonging to that quote). Changes to delivery details require a fresh quote. New Express selections remain unavailable until pricing is configured.
- COD uses `cod_amount` in major currency units, an uppercase ISO `cod_currency`, and `cod_payment_method: "cash"`. Send amounts as decimal strings, not floating-point calculations. For example, `"125.5"` TND is persisted as `125500` millimes. Excess currency precision and amounts beyond the signed SQL INT column limit are rejected, never rounded.
- Document attachments use uploaded file UUID strings in `files`. Uploading a file and attaching it to an order remain separate operations.

Order creation runs inside a database transaction, including payload, parcels, purchase rate, core transaction, and attachment association writes on the configured connection. Quote and existing-order locks serialize quote consumption. An identical retry using the same available quote returns the existing order without repeating those writes. Changed notes/documents conflict with HTTP 409; changed quoted delivery details require a new quote. A deleted order cannot free its quote for reuse. Expired quotes are rejected, including retries after expiry.

The quote reference and retry fingerprint are persisted in `meta.customer_portal`; there is no `orders.service_quote_uuid` column. Existing purchase-rate links also identify previously consumed quotes. Legacy requests without `meta.delivery` retain optional parcel/quote behavior. Saved phone numbers remain optional; this change does not introduce a mandatory-phone policy.

Regression coverage is in the host API's `tests/Unit/PortalDeliveryCreationTest.php`, including real SQLite payload/order/core-financial persistence, flat/nested requests, replay, account/expiry checks, money boundaries, and late-failure rollback. Tracking/webhook side effects and the separate Ledger invoice integration are isolated in these tests. Verify MySQL concurrency, Ledger/payment integration, and device workflows in staging before coordinated rollout.

### Creation interface safeguards

The portal offers optional cash collection in TND, separate from delivery charges. The amount, currency, and cash method are serialized identically for quotes and creation. Returns do not inherit COD. Parcel names, numeric fields, packaging, route stops, schedule, and proof settings must be valid before rates can be requested.

Creation requires a selected quote from the current draft revision. Every route, parcel, delivery-option, schedule, and COD edit invalidates previous rates; late responses cannot restore them. **Refresh delivery rates** supports retry after a rate lookup failure. Pending document uploads block creation, including multiple concurrent uploads; failed uploads notify the customer and clear their pending state so files can be selected again. Successfully uploaded file UUIDs are sent only with creation, not quoting.

The host Console's `tests/unit/services/delivery-creation-parity-test.js` exercises portal and Console services/components together, including upload gating, stale responses, COD boundaries, draft restoration, repeated submission and payment-finalization retry. Phone numbers remain optional.

Checkout draft transfer uses protected `GET/POST checkout-drafts` and `GET/PUT checkout-drafts/{uuid}` endpoints, scoped to company/account/user. Deploy the parent application's `2026_10_26_000002_create_portal_checkout_drafts.php` migration first. Drafts expire after 24 hours; links use `?checkout_draft={uuid}` with no personal data. The new-order route restores the complete input, converts mobile endpoint-plus-intermediate routes into typed portal waypoints, and refreshes quotes. Before Stripe initialization, the portal persists the selected quote and draft and includes its UUID in the return URI. Cancel/retry retains that state; failed order finalization must not clear callback parameters. Server-side draft row locking and the stored resulting order UUID prevent repeated finalization from creating another order. Completed drafts reopen the existing order.

Opaque checkout parameters survive login and two-factor authentication in per-tab session storage. The new-order controller declares those query parameters and resets them on exit so a later new delivery cannot accidentally reopen the previous checkout.

New checkout sessions include quote/company metadata and require confirmed payment. In-flight pre-upgrade sessions without metadata fail explicitly and need reconciliation before rollout. Local fake-gateway tests do not replace Stripe staging validation, production-database concurrency testing or Ledger acceptance.

## Installation

Install the backend package in the Fleetbase API:

```bash
composer require fleetbase/customer-portal-api
```

Install the Ember engine in Fleetbase Console:

```bash
pnpm install @fleetbase/customer-portal-engine
```

The package also depends on Fleetbase shared frontend packages and first-party backend packages, including Core API, FleetOps, and Ledger.

## Development Setup

For local Fleetbase extension development, use Fleetbase's package linker so Console and API resolve this checkout instead of published package versions. See the official [Fleetbase Development Setup guide](https://www.fleetbase.io/docs/platform/quickstart/development-setup) for the full workflow.

Clone Fleetbase with submodules:

```bash
git clone https://github.com/fleetbase/fleetbase.git
cd fleetbase
git submodule update --init --recursive
```

Install the package linker once from the Fleetbase repository root:

```bash
npm link
flb-package-linker --help
```

Enable the customer portal package:

```bash
flb-package-linker enable customer-portal
flb-package-linker install customer-portal
```

You can let the linker run install commands immediately:

```bash
flb-package-linker enable customer-portal --install
```

For backend package work in Docker, mount local source into the application container:

```yaml
services:
  application:
    environment:
      ENVIRONMENT: "development"
      APP_DEBUG: "true"
    volumes:
      - ./api:/fleetbase/api
      - ./packages:/fleetbase/packages
```

Restart the stack after changing Docker mounts:

```bash
docker compose up -d
```

Fleetbase runs Laravel Octane, so reload the application worker after PHP changes:

```bash
docker compose exec application php artisan octane:reload
```

For frontend work, run the Fleetbase Console development server locally or in Docker. The local path is usually the fastest:

```bash
docker compose stop console
cd console
pnpm install
pnpm start:dev
```

Console will be available at:

```text
http://localhost:4200
```

## Configuration

The backend config lives in `server/config/customer-portal.php`:

```php
return [
    'api' => [
        'version' => '0.0.1',
        'routing' => [
            'prefix' => 'customer-portal',
            'internal_prefix' => 'int',
        ],
    ],
];
```

Portal admins can configure customer portal behavior from Fleetbase Console settings. The package includes API support for:

- Portal configuration loading and saving
- Customer access URL slug validation
- Enabled order configurations
- Enabled service rates
- Payment availability and Stripe-backed checkout configuration

## Quality Checks

Install dependencies for this package:

```bash
pnpm install
composer install
```

Run frontend checks:

```bash
pnpm lint
pnpm test
```

Run backend checks:

```bash
composer test
```

Useful focused commands:

```bash
pnpm start
pnpm build
pnpm test:ember
pnpm test:ember-compatibility
composer test:lint
composer test:types
composer test:unit
```

## Contributing

Contributions are welcome. Keep changes scoped, include tests for behavior changes, and verify both the Ember engine and Laravel package paths when a feature crosses the frontend/backend boundary.

When developing inside the Fleetbase monorepo, prefer `flb-package-linker` over manual `package.json`, `composer.json`, or workspace edits so local development links remain reversible.

## License

Fleetbase Customer Portal is released under the GNU Affero General Public License v3.0 or later. See [LICENSE.md](LICENSE.md) for details.
