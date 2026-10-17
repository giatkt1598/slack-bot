export const ticketPattern = /^[A-Z][A-Z0-9]*-[0-9]+$/;

export function validateTicket(ticket: unknown): string {
  if (typeof ticket !== 'string' || !ticketPattern.test(ticket)) {
    throw new Error('Ticket must look like GCD-123.');
  }
  return ticket;
}
