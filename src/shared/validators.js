const ticketPattern = /^[A-Z][A-Z0-9]*-[0-9]+$/;

function validateTicket(ticket) {
  if (typeof ticket !== 'string' || !ticketPattern.test(ticket)) {
    throw new Error('Ticket phải có định dạng như GCD-123.');
  }
  return ticket;
}

module.exports = { ticketPattern, validateTicket };
