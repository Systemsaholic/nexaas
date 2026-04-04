import { listInstances, deleteInstance } from "@/lib/ovh";
import { ok, err } from "@/lib/api-response";

export async function GET() {
  try {
    const instances = await listInstances();
    return ok(instances);
  } catch (e) {
    return err(`Failed to list OVH instances: ${(e as Error).message}`, 500);
  }
}

export async function DELETE(request: Request) {
  const { instanceId } = await request.json();

  if (!instanceId) return err("instanceId is required");

  try {
    await deleteInstance(instanceId);
    return ok({ message: `Instance ${instanceId} deleted` });
  } catch (e) {
    return err(`Failed to delete instance: ${(e as Error).message}`, 500);
  }
}
