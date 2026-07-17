import { NextResponse } from "next/server";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "https://dmail-backedn.onrender.com"; // Dynamic fallback to default backend URL

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Proxy the request to the Render backend which has SMTP configured
    const backendResponse = await fetch(`${BACKEND_URL}/api/send-external`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await backendResponse.json().catch(() => ({ error: "Invalid response from backend" }));

    if (!backendResponse.ok) {
      return NextResponse.json(
        { error: data.error || `Backend returned status ${backendResponse.status}` },
        { status: backendResponse.status }
      );
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("API /send-external proxy error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to reach mail backend" },
      { status: 500 }
    );
  }
}
