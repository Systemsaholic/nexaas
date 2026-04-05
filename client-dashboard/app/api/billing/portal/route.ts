import { getStripe } from "@/lib/stripe";
import { queryOne } from "@/lib/db";
import { NextResponse } from "next/server";

// POST: Create Stripe Customer Portal session
export async function POST() {
  const ws = process.env.NEXAAS_WORKSPACE ?? "";

  try {
    const stripe = getStripe();

    // Get or create Stripe customer for this workspace
    const account = await queryOne<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM accounts WHERE id = $1`,
      [ws]
    );

    let customerId = account?.stripe_customer_id;

    if (!customerId) {
      // Create Stripe customer
      const customer = await stripe.customers.create({
        metadata: { workspace_id: ws },
        description: `Nexmatic workspace: ${ws}`,
      });
      customerId = customer.id;

      // Store customer ID
      await queryOne(
        `UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2`,
        [customerId, ws]
      );
    }

    // Create portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.NEXTAUTH_URL}/billing`,
    });

    return NextResponse.json({ ok: true, data: { url: session.url } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
