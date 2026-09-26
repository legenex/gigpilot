"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";
import { cn, Logo } from "@gigpilot/ui";
import { LinkButton } from "./link-button";

interface NavBarProps {
  /** Resolved on the server per request — never decided on the client. */
  signedIn: boolean;
  urls: { app: string; login: string; signup: string };
  links: { href: string; label: string; index: string }[];
}

export function NavBar({ signedIn, urls, links }: NavBarProps) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onResize = () => window.innerWidth >= 1024 && setOpen(false);
    document.documentElement.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.documentElement.style.overflow = "";
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-[background-color,box-shadow] duration-200",
        // No backdrop-filter while the menu is open: it would become the containing block of the fixed panel.
        open
          ? "bg-bg shadow-[inset_0_-1px_0_var(--gp-line)]"
          : scrolled
            ? "bg-[rgba(8,9,11,0.86)] shadow-[inset_0_-1px_0_var(--gp-line)] backdrop-blur-md"
            : "bg-transparent",
      )}
    >
      <nav aria-label="Primary" className="site-container flex h-16 items-center gap-6">
        <Link href="/" className="focus-ring -m-1 rounded-sm p-1" aria-label="GigPilot home">
          <Logo />
        </Link>

        <ul className="ml-4 hidden items-center gap-1 lg:flex">
          {links.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="focus-ring rounded-sm px-2.5 py-1.5 text-[13px] text-fg-2 transition-colors hover:text-fg">
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {signedIn ? (
            <LinkButton href={urls.app} size="sm" data-testid="nav-dashboard">
              Go to Dashboard
              <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover/btn:translate-x-0.5" strokeWidth={2} />
            </LinkButton>
          ) : (
            <>
              <LinkButton href={urls.login} variant="ghost" size="sm" data-testid="nav-login">
                Log in
              </LinkButton>
              <LinkButton href={urls.signup} size="sm" data-testid="nav-signup">
                Sign up
              </LinkButton>
            </>
          )}
          <button
            ref={buttonRef}
            type="button"
            className="focus-ring -mr-1.5 ml-1 inline-flex size-9 items-center justify-center rounded-sm text-fg-2 hover:bg-surface-1 hover:text-fg lg:hidden"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="size-[18px]" strokeWidth={1.75} /> : <Menu className="size-[18px]" strokeWidth={1.75} />}
          </button>
        </div>
      </nav>

      <div
        id={panelId}
        hidden={!open}
        className="fixed inset-x-0 bottom-0 top-16 overflow-y-auto bg-bg lg:hidden"
        data-testid="mobile-menu"
      >
        <div className="site-container flex min-h-full flex-col pb-10 pt-4">
          <p className="label mb-2">Navigate</p>
          <ul className="divide-y divide-line border-y border-line">
            {links.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="focus-ring flex items-baseline justify-between py-4 font-display text-[22px] font-semibold tracking-[-0.02em] text-fg"
                >
                  {l.label}
                  <span className="label">{l.index}</span>
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-8 grid gap-2">
            {signedIn ? (
              <LinkButton href={urls.app} size="lg" data-testid="mobile-nav-dashboard">
                Go to Dashboard
                <ArrowRight aria-hidden className="size-4" strokeWidth={2} />
              </LinkButton>
            ) : (
              <>
                <LinkButton href={urls.signup} size="lg" data-testid="mobile-nav-signup">
                  Sign up
                </LinkButton>
                <LinkButton href={urls.login} variant="outline" size="lg" data-testid="mobile-nav-login">
                  Log in
                </LinkButton>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
