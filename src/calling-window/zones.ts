/** IANA zone to the NANP area codes inside one zone, all year. Codes spanning zones are left out on purpose. */
const NANP_ZONES: Record<string, string> = {
  'America/New_York':
    '202 203 207 212 215 216 220 223 226 229 234 239 240 248 249 252 260 267 272 289 301 302 304 305 313 315 321 330 332 339 343 347 351 352 365 380 382 386 401 404 407 410 412 413 416 437 440 443 445 463 470 475 478 484 508 513 516 517 518 519 540 548 551 561 567 570 571 582 585 586 603 607 609 610 613 614 616 617 631 640 646 647 656 667 678 680 681 686 689 703 704 705 717 718 724 727 732 734 740 742 743 754 757 765 771 772 774 781 786 802 803 804 810 813 814 835 838 839 843 845 848 854 856 857 859 862 863 864 865 878 904 905 908 910 912 914 917 919 929 934 937 941 943 947 948 954 959 973 978 980 984 989 502 606',
  'America/Chicago':
    '205 214 217 218 224 225 228 251 254 256 262 274 281 309 312 314 316 318 319 320 325 331 334 337 346 361 402 405 409 414 417 430 469 479 501 504 507 512 515 531 534 539 557 563 572 573 580 601 608 612 615 618 629 630 636 641 651 659 660 662 682 708 712 713 715 726 731 737 763 769 773 779 806 815 816 817 830 832 847 870 872 901 903 913 918 920 931 936 938 940 952 956 972 975 979 985 204 431',
  'America/Denver': '303 307 385 403 406 435 505 575 587 368 719 720 780 801 825 970 983',
  'America/Phoenix': '480 520 602 623',
  'America/Los_Angeles':
    '206 209 213 253 424 279 310 323 341 360 408 415 425 442 503 509 510 530 559 562 564 604 619 626 628 650 657 661 669 702 707 714 725 747 760 805 818 820 831 840 858 909 916 925 949 951 971',
  'Pacific/Honolulu': '808',
  'America/Halifax': '506 782 902',
  'America/Puerto_Rico': '787 939',
  'America/St_Thomas': '340',
  'America/Jamaica': '658 876',
  'America/Santo_Domingo': '809 829 849',
  'Pacific/Guam': '671',
}

/** Calling codes of countries that sit in one zone for the whole country. */
const COUNTRY_ZONES: Record<string, string> = {
  '31': 'Europe/Amsterdam',
  '32': 'Europe/Brussels',
  '33': 'Europe/Paris',
  '39': 'Europe/Rome',
  '41': 'Europe/Zurich',
  '43': 'Europe/Vienna',
  '44': 'Europe/London',
  '45': 'Europe/Copenhagen',
  '46': 'Europe/Stockholm',
  '47': 'Europe/Oslo',
  '48': 'Europe/Warsaw',
  '49': 'Europe/Berlin',
  '65': 'Asia/Singapore',
  '81': 'Asia/Tokyo',
  '82': 'Asia/Seoul',
  '86': 'Asia/Shanghai',
  '90': 'Europe/Istanbul',
  '91': 'Asia/Kolkata',
  '353': 'Europe/Dublin',
  '852': 'Asia/Hong_Kong',
  '971': 'Asia/Dubai',
  '972': 'Asia/Jerusalem',
}

const AREA_CODE_ZONE = new Map<string, string>()
for (const [zone, codes] of Object.entries(NANP_ZONES)) {
  for (const code of codes.split(' ')) {
    if (!/^\d{3}$/.test(code)) {
      throw new Error(`bad area code ${code}`)
    }
    if (AREA_CODE_ZONE.has(code)) {
      throw new Error(`area code ${code} listed twice`)
    }
    AREA_CODE_ZONE.set(code, zone)
  }
}

/** Reports whether `zone` is an IANA zone name this runtime knows. */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * Returns the one IANA zone an E.164 number sits in, or undefined when it cannot be fixed
 * (malformed, a multi-zone country, an unlisted or zone-spanning area code). An `override`
 * wins when it is a valid zone; an invalid override gives undefined, never the number's zone.
 */
export function timeZoneForNumber(e164: string, override?: string): string | undefined {
  if (override !== undefined) {
    return isKnownTimeZone(override) ? override : undefined
  }
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) {
    return undefined
  }
  if (e164.startsWith('+1')) {
    return e164.length === 12 && /^\+1[2-9]/.test(e164)
      ? AREA_CODE_ZONE.get(e164.slice(2, 5))
      : undefined
  }
  for (const length of [3, 2]) {
    const zone = COUNTRY_ZONES[e164.slice(1, 1 + length)]
    if (zone) {
      return zone
    }
  }
  return undefined
}
