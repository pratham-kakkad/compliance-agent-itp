import { useNavigate } from "react-router-dom";
import { Compass } from "lucide-react";
import { Button, Card, EmptyState } from "../ui";

export function NotFound() {
  const navigate = useNavigate();
  return (
    <Card>
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="The page you're looking for doesn't exist or has moved."
        action={<Button variant="primary" onClick={() => navigate("/")}>Back to dashboard</Button>}
      />
    </Card>
  );
}
