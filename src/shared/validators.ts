export const ticketPattern = /^[A-Z][A-Z0-9]*-[0-9]+$/;

export function validateTicket(ticket: unknown): string {
  if (typeof ticket !== 'string' || !ticketPattern.test(ticket)) {
    throw new Error('Ticket phải có định dạng như GCD-123.');
  }
  return ticket;
}
