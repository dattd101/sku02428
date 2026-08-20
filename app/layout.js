import './globals.css';
import Script from 'next/script';

const GA_MEASUREMENT_ID = 'G-L1JNNEFMQC';

export const metadata = {
  title: 'Temp Chat',
  description: 'Ephemeral realtime chat with temporary sessions',
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi">
      <body suppressHydrationWarning>
        {children}
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${GA_MEASUREMENT_ID}');
          `}
        </Script>
      </body>
    </html>
  );
}
