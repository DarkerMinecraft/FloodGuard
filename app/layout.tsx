import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FloodGuard",
  description: "Flood warnings and hazards for where you are.",
  applicationName: "FloodGuard",
  // iOS ignores most of the manifest, so it needs these to run full-screen from the home screen.
  appleWebApp: {
    capable: true,
    title: "FloodGuard",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0b3a6e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const TOAST_TOP = "calc(max(1rem, env(safe-area-inset-top)) + 3.75rem)";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <ServiceWorkerRegister />
        {/* Below the top bar (menu button and threat pill), which sits at max(1rem, safe area) and is 3rem tall. */}
        <Toaster
          theme="dark"
          position="top-center"
          richColors
          closeButton
          offset={{ top: TOAST_TOP }}
          mobileOffset={{ top: TOAST_TOP, left: "1rem", right: "1rem" }}
        />
      </body>
    </html>
  );
}
