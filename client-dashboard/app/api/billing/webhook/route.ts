import { getStripe } from "@/lib/stripe";
import { query } from "@/lib/db";
import { NextResponse } from "next/server";

// POST: Stripe webhook handler
export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return NextResponse.json({ error: "Missing signature or webhook secret" }, { status: 400 });
  }

  try {
    const stripe = getStripe();
    const event = stripe.webhooks.constructEvent(body, sig, webhookSecret);

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as any;
        await query(
          `UPDATE accounts SET stripe_subscription_id = $1, status = $2, updated_at = NOW()
           WHERE stripe_customer_id = $3`,
          [subscription.id, subscription.status === "active" ? "active" : "suspended", subscription.customer]
        );
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as any;
        await query(
          `UPDATE accounts SET status = 'cancelled', updated_at = NOW()
           WHERE stripe_customer_id = $1`,
          [subscription.customer]
        );
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as any;
        await query(
          `UPDATE accounts SET status = 'suspended', updated_at = NOW()
           WHERE stripe_customer_id = $1`,
          [invoice.customer]
        );
        break;
      }
    }

    return NextResponse.json({ received: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
