import './globals.css';

export const metadata = {
  title: 'Temp Chat',
  description: 'Ephemeral realtime chat with temporary sessions',
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
